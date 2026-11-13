// A2UI 1.0 (Agent-to-User Interface) alongside the MCP tools. https://a2ui.org/specification/v1.0-a2ui/
//
// What this module does
//   * builds A2UI messages (createSurface / updateDataModel) from data the existing tools return:
//     a form per calculator, a result card, a templates list with a confirm step before a download
//   * validates the renderer-to-agent messages it receives (action) and answers with a stream of
//     agent-to-renderer messages (SSE, one JSON message per event)
//   * keeps a registry of actions; an action marked `sensitive` only runs after the user confirmed
//     it on a server-issued, signed, single-purpose token (see confirmCard / verifyToken)
//
// Security rules followed (spec "security" sections):
//   * only components of the basic catalog are used; no code, no inline catalogs, no theme
//   * the agent never trusts values the client sends back: ids are checked against the catalog,
//     inputs against the calculator's own schema, and URLs come from the server's catalog only
//   * nothing sensitive goes in a payload: only what the tool already returned to the model
//   * every message is built from plain JSON data; the renderer is the only thing that draws
const crypto = require('crypto');

const VERSION = '1.0';
const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_TEXT = 4000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const SECRET = crypto.randomBytes(32); // per process: tokens do not survive a restart, which is fine for a 5 minute window

// Words the server puts inside surfaces. Calculator input names and descriptions come from the
// calculator catalog (English), so only the interface words are translated here.
const TX = {
  en: { run: 'Run', templates: n => `${n} templates`, open: 'Open', ask: t => `Open the download of "${t}" in a new tab?`, confirm: 'Confirm', cancel: 'Cancel', sure: 'Confirm this action?', json: 'JSON' },
  ar: { run: 'تشغيل', templates: n => `${n} قالب`, open: 'فتح', ask: t => `فتح تحميل «${t}» في تبويب جديد؟`, confirm: 'تأكيد', cancel: 'إلغاء', sure: 'تأكيد هذا الإجراء؟', json: 'JSON' },
};
const tx = lang => TX[lang === 'ar' ? 'ar' : 'en'];

const msg = (key, body) => ({ version: VERSION, [key]: body });
const text = (id, t, variant) => ({ id, component: 'Text', text: String(t).slice(0, MAX_TEXT), ...(variant ? { variant } : {}) });

// ---------- building blocks ----------
// A calculator input schema field -> one component + the initial value it binds to
let I18N = null;
function i18n() { if (!I18N) { try { I18N = require('./calc-i18n.json'); } catch (e) { I18N = {}; } } return I18N; }
// Title/description/field labels of a calculator in the page language (catalog titles are Arabic, descriptions English)
function localize(calc, lang) {
  const t = i18n()[calc.id] || {};
  if (lang === 'en') return { title: t.titleEn || calc.title, description: calc.description, labels: {} };
  return { title: calc.title, description: t.descAr || calc.description, labels: t.fields || {} };
}
function fieldFor(key, spec, i, T, labels) {
  const id = 'f_' + i, s = spec || {}, path = '/form/' + key;
  const label = key + (labels && labels[key] ? ' - ' + labels[key] : s.description ? ' - ' + String(s.description).slice(0, 80) : '');
  if (Array.isArray(s.enum)) {
    return { c: { id, component: 'ChoicePicker', label, variant: 'mutuallyExclusive', displayStyle: 'chips',
      options: s.enum.map(v => ({ label: String(v), value: String(v) })), value: { '@path': path } }, init: s.default !== undefined ? [String(s.default)] : [] };
  }
  if (s.type === 'boolean') return { c: { id, component: 'CheckBox', label, value: { '@path': path } }, init: !!s.default };
  if (s.type === 'number' || s.type === 'integer') return { c: { id, component: 'TextField', label, variant: 'number', value: { '@path': path } }, init: s.default !== undefined ? String(s.default) : '' };
  if (s.type === 'array' || s.type === 'object') return { c: { id, component: 'TextField', label: label + ' (' + T.json + ')', variant: 'longText', value: { '@path': path } }, init: '' };
  return { c: { id, component: 'TextField', label, variant: 'shortText', value: { '@path': path } }, init: s.default !== undefined ? String(s.default) : '' };
}

// Messages that open a calculator form. `calc` is an entry of calculators.catalog().
function calculatorSurface(calc, lang) {
  const T = tx(lang);
  const L = localize(calc, lang);
  const fields = Object.keys(calc.inputs || {}).slice(0, 12).map((k, i) => ({ k, ...fieldFor(k, calc.inputs[k], i, T, L.labels) }));
  const form = {};
  fields.forEach(f => { form[f.k] = f.init; });
  const components = [
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column', children: ['title', 'desc', ...fields.map(f => f.c.id), 'run', 'status', 'result'] },
    text('title', L.title || calc.id, 'body'),
    text('desc', L.description || '', 'caption'),
    ...fields.map(f => f.c),
    { id: 'run', component: 'Button', variant: 'primary', child: 'run_label',
      action: { event: { name: 'run_calculator', context: { id: calc.id, inputs: { '@path': '/form' } } } } },
    text('run_label', T.run),
    text('status', { '@path': '/status' }),
    text('result', { '@path': '/result' }),
  ];
  // Text.text accepts a binding: replace the placeholder strings written by text()
  components.find(c => c.id === 'status').text = { '@path': '/status' };
  components.find(c => c.id === 'result').text = { '@path': '/result' };
  return [msg('createSurface', { surfaceId: 'calc-' + calc.id, catalogId: CATALOG, sendDataModel: false, components, dataModel: { form, status: '', result: '' } })];
}

// A readable markdown view of a tool result: flat "key: value" lines, nested up to 2 levels, capped
let RI = null;
function resultLabels() { if (!RI) { try { RI = require('./result-i18n.json'); } catch (e) { RI = {}; } } return RI; }
// Result key -> readable name: Arabic from result-i18n.json, English by splitting snake_case / camelCase
function keyLabel(k, lang, calcId) {
  if (/^\d+$/.test(k)) return k;
  if (lang === 'ar') { const d = resultLabels(); return (d['@' + calcId] || {})[k] || d[k] || k; }
  const w = k.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}
function resultMarkdown(r, lang, calcId) {
  const lines = [];
  const walk = (v, prefix, depth) => {
    if (lines.length >= 60) return;
    if (v === null || v === undefined) return;
    if (typeof v !== 'object') { lines.push(`- **${prefix}**: ${String(v).slice(0, 200)}`); return; }
    if (depth >= 2) { lines.push(`- **${prefix}**: ${JSON.stringify(v).slice(0, 200)}`); return; }
    (Array.isArray(v) ? v.slice(0, 20).map((x, i) => [String(i + 1), x]) : Object.entries(v)).forEach(([k, x]) => walk(x, prefix ? prefix + ' / ' + keyLabel(k, lang, calcId) : keyLabel(k, lang, calcId), depth + 1));
  };
  walk(r, '', 0);
  return lines.join('\n') || '-';
}

// A surface that only shows a finished result (used when a tool already ran)
function resultSurface(id, title, result) {
  return [msg('createSurface', { surfaceId: 'result-' + id, catalogId: CATALOG, components: [
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column', children: ['title', 'md'] },
    text('title', title, 'body'),
    text('md', resultMarkdown(result)),
  ] })];
}

// Templates list. Every download goes through a Modal: the click only asks, the second click opens.
// The URLs come from the catalog (server side) and are sent in the data model, never from the client.
function templatesSurface(items, lang) {
  const T = tx(lang);
  const list = items.slice(0, 12).filter(t => t && ID_RE.test(t.id)).map(t => lang === 'en' && t.titleEn ? { ...t, title: t.titleEn } : t);
  const links = {};
  const components = [{ id: 'root', component: 'Card', child: 'body' }, { id: 'body', component: 'Column', children: ['head', ...list.map((t, i) => 'row_' + i)] }, text('head', T.templates(list.length), 'body')];
  list.forEach((t, i) => {
    links[t.id] = t.download || '';
    components.push(
      { id: 'row_' + i, component: 'Row', align: 'center', justify: 'spaceBetween', children: ['name_' + i, 'modal_' + i] },
      text('name_' + i, t.title || t.id),
      { id: 'dl_' + i, component: 'Button', variant: 'borderless', child: 'dl_label_' + i, action: { event: { name: 'noop', context: {} } } },
      text('dl_label_' + i, 'xlsx'),
      { id: 'modal_' + i, component: 'Modal', trigger: 'dl_' + i, content: 'ask_' + i },
      { id: 'ask_' + i, component: 'Column', children: ['ask_text_' + i, 'ask_go_' + i] },
      text('ask_text_' + i, T.ask(t.title || t.id)),
      { id: 'ask_go_' + i, component: 'Button', variant: 'primary', child: 'ask_go_label_' + i,
        action: { functionCall: { '@call': 'openUrl', args: { url: { '@path': '/links/' + t.id } } } } },
      text('ask_go_label_' + i, T.open),
    );
  });
  return [msg('createSurface', { surfaceId: 'templates', catalogId: CATALOG, components, dataModel: { links } })];
}

// ---------- confirmation for sensitive / irreversible actions ----------
// The token binds an action name + its context to a time window. The client cannot forge or reuse it for
// another action, and a token is only handed out by confirmCard(), which the user must press through.
function signToken(name, context, exp) {
  const body = Buffer.from(JSON.stringify({ n: name, c: context, e: exp })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verifyToken(token, name, context) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return false;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return false; }
  return p.n === name && JSON.stringify(p.c) === JSON.stringify(context) && p.e > Date.now();
}
function confirmCard(surfaceId, name, context, question, lang) {
  const T = tx(lang);
  const token = signToken(name, context, Date.now() + TOKEN_TTL_MS);
  return [msg('createSurface', { surfaceId: 'confirm-' + surfaceId, catalogId: CATALOG, components: [
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column', children: ['q', 'row'] },
    text('q', question, 'body'),
    { id: 'row', component: 'Row', justify: 'start', children: ['yes', 'no'] },
    { id: 'yes', component: 'Button', variant: 'primary', child: 'yes_l', action: { event: { name, context: { ...context, confirmToken: token } } } },
    text('yes_l', T.confirm),
    { id: 'no', component: 'Button', variant: 'borderless', child: 'no_l', action: { event: { name: 'cancel', context: { surfaceId } } } },
    text('no_l', T.cancel),
  ] })];
}

// ---------- validation of what the renderer sends ----------
// Shape per spec: { version: "1.0", action: { name, surfaceId, sourceComponentId, timestamp, context } }
function parseAction(body) {
  const m = body && body.message;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: { code: 'VALIDATION_FAILED', message: 'message must be an object' } };
  if (m.version !== VERSION) return { error: { code: 'VALIDATION_FAILED', message: 'version must be "1.0"' } };
  const keys = Object.keys(m).filter(k => k !== 'version');
  if (keys.length !== 1 || keys[0] !== 'action') return { error: { code: 'VALIDATION_FAILED', message: 'exactly one of the supported keys: action' } };
  const a = m.action;
  if (!a || typeof a.name !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(a.name)) return { error: { code: 'VALIDATION_FAILED', message: 'action.name is invalid' } };
  if (typeof a.surfaceId !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,80}$/i.test(a.surfaceId)) return { error: { code: 'VALIDATION_FAILED', message: 'action.surfaceId is invalid' } };
  if (a.context !== undefined && (typeof a.context !== 'object' || a.context === null || Array.isArray(a.context))) return { error: { code: 'VALIDATION_FAILED', message: 'action.context must be an object' } };
  return { action: { name: a.name, surfaceId: a.surfaceId, context: a.context || {} } };
}

// Coerce what a form produced (strings, one-item arrays) to what the calculator's schema expects.
// Anything unknown is dropped; the calculator itself still validates the values.
function coerceInputs(schema, raw) {
  const out = {};
  Object.keys(schema || {}).forEach(k => {
    let v = raw ? raw[k] : undefined;
    const s = schema[k] || {};
    if (Array.isArray(v) && (s.enum || s.type !== 'array')) v = v[0];
    if (v === undefined || v === '' || v === null) return;
    if (s.type === 'number' || s.type === 'integer') { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${k} must be a number`); out[k] = n; }
    else if (s.type === 'boolean') out[k] = v === true || v === 'true';
    else if (s.type === 'array' || s.type === 'object') { try { out[k] = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { throw new Error(`${k} must be valid JSON`); } }
    else out[k] = String(v).slice(0, 500);
  });
  return out;
}

// ---------- the action registry ----------
// handler(ctx, tools) -> array of agent-to-renderer messages. `sensitive: true` demands a confirmToken.
// tools = { calculators, mcpCall } from index.js. Add an action with registerAction().
const ACTIONS = {
  run_calculator: {
    sensitive: false,
    async handler(a, tools, lang) {
      const id = String(a.context.id || '');
      if (!ID_RE.test(id)) throw Object.assign(new Error('unknown calculator'), { code: 'VALIDATION_FAILED' });
      const calc = tools.calculators.catalog().find(c => c.id === id);
      if (!calc) throw Object.assign(new Error('unknown calculator'), { code: 'VALIDATION_FAILED' });
      const sid = a.surfaceId;
      const inputs = coerceInputs(calc.inputs, a.context.inputs);
      const result = await tools.calculators.run(id, inputs);
      return [
        msg('updateDataModel', { surfaceId: sid, path: '/status', value: '' }),
        msg('updateDataModel', { surfaceId: sid, path: '/result', value: resultMarkdown(result, lang, id) }),
      ];
    },
  },
  cancel: { sensitive: false, async handler(a) { return [msg('deleteSurface', { surfaceId: 'confirm-' + String(a.context.surfaceId || '').slice(0, 60) })]; } },
  noop: { sensitive: false, async handler() { return []; } },
};
function registerAction(name, def) { ACTIONS[name] = def; }

// Runs one validated action and returns { messages } or { error }
async function handleAction(parsed, tools, lang) {
  if (parsed.error) return { error: parsed.error };
  const a = parsed.action, def = ACTIONS[a.name];
  if (!def) return { error: { code: 'EXECUTION_ERROR', message: 'unknown action' } };
  try {
    if (def.sensitive) {
      const { confirmToken, ...ctx } = a.context;
      if (!confirmToken) return { messages: confirmCard(a.surfaceId, a.name, ctx, def.question || tx(lang).sure, lang) };
      if (!verifyToken(confirmToken, a.name, ctx)) return { error: { code: 'EXECUTION_ERROR', message: 'confirmation expired or invalid; confirm again' } };
      return { messages: await def.handler({ ...a, context: ctx }, tools, lang) };
    }
    return { messages: await def.handler(a, tools, lang) };
  } catch (e) {
    return { error: { code: e.code && typeof e.code === 'string' ? e.code : 'EXECUTION_ERROR', message: String(e.message).slice(0, 300) } };
  }
}

// One agent-to-renderer message as a Server-Sent Event; errors use the spec's error shape
const sse = m => `data: ${JSON.stringify(m)}\n\n`;
const errorMessage = (e, surfaceId) => ({ version: VERSION, error: { ...(surfaceId ? { surfaceId } : {}), code: e.code, message: e.message } });

module.exports = { localize, VERSION, CATALOG, calculatorSurface, resultSurface, templatesSurface, confirmCard, parseAction, handleAction, registerAction, verifyToken, signToken, sse, errorMessage, resultMarkdown, coerceInputs };
