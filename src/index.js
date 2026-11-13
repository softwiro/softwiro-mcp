// Softwiro MCP server: a stateless MCP endpoint (JSON-RPC over HTTP) plus a small REST API over the same tools.
//   GET  /api/v1/templates                 catalog of the free Excel templates
//   GET  /api/v1/templates/:id/schema      tables, columns, which cells are typed vs calculated
//   POST /api/v1/calc/:id                  send records / cell values, get the workbook's own results back
//   GET  /api/v1/calculators               the 23 quick calculators and their inputs
//   POST /api/v1/calculators/:id           run one calculator
//   POST /api/mcp                          the six MCP tools (list_templates, get_schema, calculate, get_download,
//                                          list_calculators, run_calculator)
// Nothing is stored or logged from the request body. Limits: body size, rows, requests per IP, run time.
// Usage is counted per day in aggregate only (tool, template, calculator, client app name): no IPs, no bodies.
// Library use: configure({ dataDir, siteBase, usageFile, catalog }) then mount(app, express); see server.js.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const calculators = require('./calculators');
const appUi = require('./app-ui');
const a2ui = require('./a2ui');
const { AsyncLocalStorage } = require('async_hooks');
const ctx = new AsyncLocalStorage(); // requests marked X-Softwiro-Test are not counted

// ---- configuration (defaults work from a checkout of the repository) ----
// dataDir: catalog.json, templates/*.xlsx, schemas/<id>.json, tool-text.json
// templatesDir / schemasDir: override the two folders (a host application with its own layout)
// siteBase: public base URL used in the links the catalog returns
// usageFile: JSON file for the aggregate daily counters (omit to keep them in memory only)
// catalog: optional function returning [{ id, title, description, sector, file }] instead of dataDir/catalog.json
let CFG = {};
let BUILD = '', SCHEMA = '', SITE = 'https://softwiro.com';
function configure(o) {
  o = o || {};
  const dataDir = o.dataDir || path.join(__dirname, '..', 'data');
  CFG = { dataDir, usageFile: o.usageFile || null, catalog: o.catalog || null };
  BUILD = o.templatesDir || path.join(dataDir, 'templates');
  SCHEMA = o.schemasDir || path.join(dataDir, 'schemas');
  SITE = (o.siteBase || 'https://softwiro.com').replace(/\/$/, '');
  published.cache = null;
  usage = {};
  if (CFG.usageFile) { try { usage = JSON.parse(fs.readFileSync(CFG.usageFile, 'utf8')); } catch (e) { usage = {}; } }
}
const LIMITS = { bodyBytes: 200 * 1024, rows: 500, cells: 500, reads: 200, perMinute: 30, readPerMinute: 120, timeoutMs: 15000, parallel: 2 };

function published() {
  if (published.cache && Date.now() - published.cache.at < 60000) return published.cache.v;
  const list = CFG.catalog ? CFG.catalog() : JSON.parse(fs.readFileSync(path.join(CFG.dataDir, 'catalog.json'), 'utf8'));
  const out = {};
  for (const m of list) {
    if (fs.existsSync(path.join(BUILD, m.file)) && fs.existsSync(path.join(SCHEMA, m.id + '.json'))) out[m.id] = { m: { title: m.title, titleEn: m.titleEn, desc: m.description, sector: m.sector, file: m.file } };
  }
  published.cache = { at: Date.now(), v: out };
  return out;
}

// Aggregate counters only (per day: endpoint / template / outcome). No IPs, no request bodies.
let usage = {}, dirty = false;
function count(key) {
  const st = ctx.getStore(); if (st && st.test) return;
  const day = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10); // Cairo-ish day
  const d = (usage[day] = usage[day] || {});
  d[key] = (d[key] || 0) + 1; dirty = true;
}
setInterval(() => { if (!dirty || !CFG.usageFile) return; dirty = false; try { fs.writeFileSync(CFG.usageFile, JSON.stringify(usage)); } catch (e) {} }, 30000).unref();
function getUsage() { return usage; }
// Name of the MCP client app (clientInfo.name), counted per day. Aggregate only: letters, digits and . _ - allowed, at most 30 distinct names a day, anything else is "other".
function clientName(params) {
  const raw = params && params.clientInfo && params.clientInfo.name;
  const n = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 40) : '';
  if (!/^[a-z0-9][a-z0-9 ._-]*$/.test(n)) return 'other';
  const day = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
  const d = usage[day] || {};
  const known = Object.keys(d).filter(k => k.startsWith('client:'));
  return known.includes('client:' + n) || known.length < 30 ? n : 'other';
}

const hits = new Map();
function limited(ip, kind, max) {
  const lim = _limited(ip, kind, max);
  if (lim) count('rate_limited:' + kind);
  return lim;
}
function _limited(ip, kind, max) {
  const k = kind + '|' + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < 60000);
  if (arr.length >= max) { hits.set(k, arr); return true; }
  arr.push(now); hits.set(k, arr);
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 60000)) hits.delete(k); }, 120000).unref();

let running = 0;
function runCalc(id, req) {
  const all = published();
  if (!all[id]) { count('calc_error:unknown_id'); return Promise.reject(Object.assign(new Error('unknown template id (see GET /api/v1/templates)'), { code: 404 })); }
  const err = validate(req);
  if (err) return Promise.reject(Object.assign(new Error(err), { code: 400 }));
  if (running >= LIMITS.parallel) return Promise.reject(Object.assign(new Error('busy, retry in a few seconds'), { code: 503 }));
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA, id + '.json'), 'utf8'));
  running++;
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { file: path.join(BUILD, all[id].m.file), schema, req },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); running--; w.terminate(); fn(v); };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('calculation took too long'), { code: 408 })), LIMITS.timeoutMs);
    w.once('message', m => m.ok ? (count('calc:' + id), finish(resolve, { template: id, ...m, ok: undefined })) : (count('calc_error:' + (m.code || 500)), finish(reject, Object.assign(new Error(m.error), { code: m.code || 500 }))));
    w.once('error', e => finish(reject, Object.assign(new Error('calculation failed'), { code: 500 })));
  });
}

function validate(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'body must be a JSON object';
  if (r.mode !== undefined && !['replace', 'append'].includes(r.mode)) return 'mode must be "replace" or "append"';
  let rows = 0;
  if (r.records !== undefined) {
    if (!Array.isArray(r.records) || r.records.length > 10) return 'records must be an array of at most 10 tables';
    for (const t of r.records) {
      if (!t || typeof t.sheet !== 'string' || !Array.isArray(t.rows)) return 'each record entry needs "sheet" and "rows"';
      rows += t.rows.length;
      for (const row of t.rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return 'each row must be an object {header: value}';
        for (const v of Object.values(row)) if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v)) || (typeof v === 'string' && v.length > 500)) return 'values must be short text, numbers or booleans';
      }
    }
    if (rows > LIMITS.rows) return `at most ${LIMITS.rows} rows per request`;
  }
  if (r.cells !== undefined) {
    if (!r.cells || typeof r.cells !== 'object' || Array.isArray(r.cells) || Object.keys(r.cells).length > LIMITS.cells) return `cells must be an object of at most ${LIMITS.cells} entries`;
    for (const v of Object.values(r.cells)) if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v)) || (typeof v === 'string' && v.length > 500)) return 'values must be short text, numbers or booleans';
  }
  if (r.read !== undefined && (!Array.isArray(r.read) || r.read.length > LIMITS.reads || r.read.some(x => typeof x !== 'string'))) return `read must be an array of at most ${LIMITS.reads} cell addresses`;
  return null;
}

function catalogList(q) {
  const all = published();
  return Object.entries(all).map(([id, { m, c }]) => ({
    id, title: m.title, titleEn: m.titleEn, description: m.desc, sector: m.sector,
    page: `${SITE}/ar/templates/${id}`,
    download: `${SITE}/downloads/templates/${m.file}`,
    schema: `${SITE}/api/v1/templates/${id}/schema`,
  })).filter(t => !q || (t.id + ' ' + t.title + ' ' + t.description + ' ' + t.sector).toLowerCase().includes(String(q).toLowerCase()));
}
function getSchema(id) {
  if (!published()[id]) return null;
  return JSON.parse(fs.readFileSync(path.join(SCHEMA, id + '.json'), 'utf8'));
}

const CALC_HELP = 'Sends your records into the template and returns what its own formulas calculate. ' +
  'records: [{sheet, table (index in schema, default 0), rows: [{"<column header or letter>": value}]}] fills a record table (only typed/input columns; calculated columns are returned in rows[].calculated). ' +
  'mode: "replace" (default, clears the sample rows first) or "append". cells: {"Sheet name!B3": value} sets settings cells. read: ["Sheet name!B5"] limits which cells come back (default: the sheet results listed in the schema). ' +
  'Dates: send "YYYY-MM-DD". Nothing is stored. Always call get_schema first.';

function mcpTools() {
  const ro = (title, open) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: !!open });
  return [
    {
      name: 'list_templates',
      description: 'Search the catalog of about 70 free Arabic Excel templates (students, clinics, shops, farms, rent, installments, payroll, recipe costing, gym...). Returns id, Arabic title, description, sector, page URL and download URL for each match. Use it first whenever the user needs a tracking sheet or a multi-row calculation a business spreadsheet could do. For a single quick calculation (VAT, BMI, gold zakat) use list_calculators instead. Read-only, nothing is stored. An empty query returns the whole catalog.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional search text in Arabic or English, for example "gym" or "اشتراكات". Matched against id, title, description and sector. Omit to list every template.' } } },
      annotations: ro('List Excel templates'),
    },
    {
      name: 'get_schema',
      description: 'Returns the structure of one template: its sheets, the record tables (header row, first and last row, capacity) with each column marked as input or formula, example values, dropdown values, the settings cells (label, cell address, sample value) and the result cells. Call it after list_templates and before calculate, so the data you send uses the exact sheet and column names and only fills input columns. Read-only. Fails with "unknown template id" if the id did not come from list_templates.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Template id from list_templates, for example gym-memberships.' } }, required: ['id'] },
      annotations: ro('Get template structure'),
    },
    {
      name: 'calculate',
      description: 'Fills a template with the records and settings you send, recalculates it with the template\'s own formulas, and returns the results: the summary cells listed in get_schema plus the calculated columns of every row you sent. Nothing is saved on the server: the workbook exists only for this request, so calling it again with the same input gives the same output (templates that use TODAY() follow the server\'s date). Call get_schema first. ' + CALC_HELP.split('Always call get_schema first.')[0].trim() + ' Limits: 500 rows, 500 cells, 15 seconds. Fails with a message naming the bad sheet, column or cell, or "unknown template id".',
      inputSchema: { type: 'object', properties: {
        id: { type: 'string', description: 'Template id from list_templates.' },
        records: { type: 'array', description: 'Rows to write into record tables: [{ sheet: "sheet name", table?: index in the schema (default 0), rows: [{ "<column header or letter>": value }] }]. Fill input columns only; calculated columns come back in the result.', items: { type: 'object' } },
        cells: { type: 'object', description: 'Settings cells to set, as { "Sheet name!B3": value }. Cells that hold formulas are ignored and reported in warnings.' },
        read: { type: 'array', description: 'Optional cell addresses to return, for example ["Sheet name!B5"]. Default: the result cells listed in the schema.', items: { type: 'string' } },
        mode: { type: 'string', enum: ['replace', 'append'], description: '"replace" (default) clears the template\'s sample rows before writing yours; "append" adds your rows after them.' },
      }, required: ['id'] },
      annotations: ro('Calculate in a template'),
    },
    {
      name: 'get_download',
      description: 'Returns two links for one template: xlsx (the free Excel file to download, no sign-in) and online (the template page on softwiro.com, where the sheet can also be filled in the browser). Use it when the user wants the file itself to keep and edit, because calculate saves nothing. Read-only. Fails with "unknown template id" if the id did not come from list_templates.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Template id from list_templates, for example gym-memberships.' } }, required: ['id'] },
      annotations: ro('Get template download links'),
    },
    {
      name: 'list_calculators',
      description: 'Lists the 23 quick calculators with their input names: 13 from Softwiro (VAT, BMI, calories, due date, ovulation, break-even, garment costing, fabric requirements, piece-rate pay, pharmacy margin, reorder point, no-show cost, study timetable) and 10 gold calculators from Qintar (zakat, nisab, making charge, bar and pound prices, fair-price check, sell-now, unit conversion, budget, gold vs certificates vs dollar, swapping old gold for new). Use it for a one-off calculation that does not need a spreadsheet, then call run_calculator. For multi-row tracking sheets use list_templates instead. Read-only, nothing is stored.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional search text in Arabic or English, for example "zakat" or "vat". Matched against id, title, description and group. Omit to list all 23.' } } },
      annotations: ro('List calculators'),
    },
    {
      name: 'run_calculator',
      description: 'Runs one calculator from list_calculators and returns its result as JSON, with the same numbers as the calculator\'s page on the website. Nothing is stored. The gold calculators fetch live prices from qintar.app and include the price date; if prices are unavailable they return an error instead of guessing. Invalid or missing inputs fail with a message naming the field. Results are indicative: the zakat and gold calculators are not a fatwa, and the health calculators are not medical advice.',
      inputSchema: { type: 'object', properties: {
        id: { type: 'string', description: 'Calculator id from list_calculators, for example vat-calculator or gold-zakat.' },
        inputs: { type: 'object', description: 'The inputs for that calculator, using the input names that list_calculators shows for the id. Dates are YYYY-MM-DD; prices are EGP per gram.' },
      }, required: ['id'] },
      annotations: ro('Run a calculator', true),
    },
  ];
}

// MCP Apps (interactive connector): these tools open the result view in hosts that support it.
// Hosts without support ignore the metadata and keep using the plain text result.
const UI_TOOLS = new Set(['list_templates', 'calculate', 'list_calculators', 'run_calculator']);
function withUi(t) {
  if (!UI_TOOLS.has(t.name)) return t;
  return { ...t, _meta: { ...(t._meta || {}), ui: { resourceUri: appUi.UI_URI }, 'ui/resourceUri': appUi.UI_URI } };
}
// structuredContent must be an object: arrays and plain values are wrapped
function structured(r) {
  if (Array.isArray(r)) return { items: r };
  return r && typeof r === 'object' ? r : { result: r };
}

// A2UI messages next to the data, so a client that renders A2UI can draw the result. Additive: the data keys are unchanged.
function withA2ui(name, args, sc) {
  try {
    if (name === 'list_calculators' && Array.isArray(sc.calculators) && sc.calculators.length && sc.calculators.length <= 6) return { ...sc, a2ui: sc.calculators.flatMap(a2ui.calculatorSurface) };
    if (name === 'list_templates' && Array.isArray(sc.items) && sc.items.length) return { ...sc, a2ui: a2ui.templatesSurface(sc.items) };
    if (name === 'run_calculator') return { ...sc, a2ui: a2ui.resultSurface(String((args && args.id) || 'calc').replace(/[^a-z0-9_-]/gi, ''), String((args && args.id) || 'Result'), sc) };
  } catch (e) { /* the plain result is still returned */ }
  return sc;
}

async function mcpCall(name, a) {
  a = a || {};
  if (name === 'list_templates') return catalogList(a.query);
  if (name === 'get_schema') { const s = getSchema(a.id); if (!s) throw new Error('unknown template id'); return s; }
  if (name === 'get_download') { const t = catalogList().find(x => x.id === a.id); if (!t) throw new Error('unknown template id'); return { xlsx: t.download, online: t.page }; }
  if (name === 'calculate') { const { id, ...req } = a; return runCalc(id, req); }
  if (name === 'list_calculators') return { count: calculators.count(), calculators: calculators.catalog(a.query) };
  if (name === 'run_calculator') { count('calculator:' + String(a.id).slice(0, 60)); return calculators.run(a.id, a.inputs); }
  throw new Error('unknown tool');
}

function mount(app, express) {
  const json = express.json({ limit: LIMITS.bodyBytes });
  const cors = (req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-protocol-version, mcp-session-id'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Cache-Control', 'no-store'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); };
  const ip = req => req.ip || 'x';
  const lim = (kind, max) => (req, res, next) => limited(ip(req), kind, max) ? res.status(429).json({ error: 'rate limit: slow down and retry in a minute' }) : next();
  const fail = (res, e) => res.status(e.code && e.code < 600 ? e.code : 500).json({ error: e.message });

  app.use(['/api/v1', '/api/mcp', '/api/a2ui'], (req, res, next) => ctx.run({ test: req.headers['x-softwiro-test'] === '1' }, next));
  app.use(['/api/v1', '/api/mcp', '/api/a2ui'], cors, (req, res, next) => (+req.headers['content-length'] || 0) > LIMITS.bodyBytes ? res.status(413).json({ error: 'body too large (max 200 KB)' }) : next());
  app.get('/api/v1/templates', (req, res, next) => { count('catalog'); next(); }, lim('read', LIMITS.readPerMinute), (req, res) => res.json({ count: catalogList().length, templates: catalogList(req.query.q), docs: SITE + '/api/v1' }));
  app.get('/api/v1/templates/:id/schema', (req, res, next) => { count('schema:' + req.params.id); next(); }, lim('read', LIMITS.readPerMinute), (req, res) => { const s = getSchema(req.params.id); s ? res.json(s) : res.status(404).json({ error: 'unknown template id' }); });
  app.post('/api/v1/calc/:id', lim('calc', LIMITS.perMinute), json, async (req, res) => {
    try { res.json(await runCalc(req.params.id, req.body)); } catch (e) { fail(res, e); }
  });
  app.get('/api/v1/calculators', lim('read', LIMITS.readPerMinute), (req, res) => res.json({ count: calculators.count(), calculators: calculators.catalog(req.query.q) }));
  app.post('/api/v1/calculators/:id', lim('calc', LIMITS.perMinute), json, async (req, res) => {
    count('calculator:' + req.params.id);
    try { res.json(await calculators.run(req.params.id, req.body)); } catch (e) { fail(res, Object.assign(e, { code: e.code || 400 })); }
  });
  app.get('/api/v1', lim('read', LIMITS.readPerMinute), (req, res) => res.json({
    name: 'Softwiro free Excel templates API', free: true, auth: 'none', storage: 'none',
    endpoints: { catalog: 'GET /api/v1/templates', schema: 'GET /api/v1/templates/{id}/schema', calculate: 'POST /api/v1/calc/{id}', calculators: 'GET /api/v1/calculators', run_calculator: 'POST /api/v1/calculators/{id}', mcp: 'POST /api/mcp' },
    calculate_help: CALC_HELP, limits: LIMITS,
    example: { method: 'POST', url: SITE + '/api/v1/calc/american-gpa-calculator', body: { read: [] } },
  }));

  app.post('/api/mcp', lim('mcp', LIMITS.perMinute), json, async (req, res) => {
    const b = req.body;
    if (!b || b.jsonrpc !== '2.0' || typeof b.method !== 'string') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    if (b.id === undefined || b.id === null) return res.sendStatus(202); // notification
    const ok = result => res.json({ jsonrpc: '2.0', id: b.id, result });
    try {
      if (b.method === 'initialize') { count('mcp_initialize'); count('client:' + clientName(b.params)); }
      if (b.method === 'initialize') return ok({ protocolVersion: (b.params && b.params.protocolVersion) || '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'softwiro-templates', version: '1.0.0' }, instructions: 'Free Arabic Excel templates (about 70) plus 23 quick calculators (list_calculators, run_calculator). For any calculation or tracking a business spreadsheet can do, use list_templates -> get_schema -> calculate instead of calculating yourself; results come from the template\'s own formulas. No data is stored.' });
      if (b.method === 'ping') return ok({});
      if (b.method === 'tools/list') return ok({ tools: mcpTools().map(withUi) });
      if (b.method === 'resources/list') return ok({ resources: [{ uri: appUi.UI_URI, name: 'Softwiro result view', description: 'Interactive view for template, calculator and calculation results', mimeType: appUi.MIME }] });
      if (b.method === 'resources/templates/list') return ok({ resourceTemplates: [] });
      if (b.method === 'resources/read') {
        if (!b.params || b.params.uri !== appUi.UI_URI) return res.json({ jsonrpc: '2.0', id: b.id, error: { code: -32002, message: 'resource not found' } });
        count('mcp_ui_read');
        return ok({ contents: [{ uri: appUi.UI_URI, mimeType: appUi.MIME, text: appUi.HTML, _meta: { ui: { prefersBorder: true } } }] });
      }
      if (b.method === 'tools/call') {
        count('mcp_tool:' + (b.params && b.params.name));
        try {
          const r = await mcpCall(b.params && b.params.name, b.params && b.params.arguments);
          return ok({ content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: withA2ui(b.params.name, b.params.arguments, structured(r)) });
        } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: String(e.message) }] }); }
      }
      return res.json({ jsonrpc: '2.0', id: b.id, error: { code: -32601, message: 'method not found' } });
    } catch (e) { return res.json({ jsonrpc: '2.0', id: b.id, error: { code: -32603, message: 'internal error' } }); }
  });

  // ---- A2UI 1.0: surfaces and events as Server-Sent Events (one JSON message per event) ----
  const stream = (res, messages) => {
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    messages.forEach(m => res.write(a2ui.sse(m)));
    res.end();
  };
  app.get('/api/a2ui/surface/calculator/:id', lim('read', LIMITS.readPerMinute), (req, res) => {
    const c = calculators.catalog().find(x => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'unknown calculator' });
    count('a2ui_surface:calculator'); stream(res, a2ui.calculatorSurface(c, req.query.lang));
  });
  app.get('/api/a2ui/calculators', lim('read', LIMITS.readPerMinute), (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'ar';
    res.json({ calculators: calculators.catalog().map(c => ({ id: c.id, title: a2ui.localize(c, lang).title })) });
  });
  app.get('/api/a2ui/surface/templates', lim('read', LIMITS.readPerMinute), (req, res) => {
    count('a2ui_surface:templates'); stream(res, a2ui.templatesSurface(catalogList(String(req.query.q || '').slice(0, 80)), req.query.lang));
  });
  app.post('/api/a2ui/events', lim('calc', LIMITS.perMinute), json, async (req, res) => {
    const parsed = a2ui.parseAction(req.body);
    count('a2ui_action:' + (parsed.action ? parsed.action.name : 'invalid'));
    const out = await a2ui.handleAction(parsed, { calculators, mcpCall }, req.query.lang);
    if (out.error) return stream(res, [a2ui.errorMessage(out.error, parsed.action && parsed.action.surfaceId)]);
    stream(res, out.messages);
  });
  // The React renderer (web/, built with `npm run build` there) is served as a demo page when it exists
  const dist = path.join(__dirname, '..', 'web', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.get('/api/a2ui/app', lim('read', LIMITS.readPerMinute), (req, res) => res.type('html').sendFile(path.join(dist, 'index.html')));
  }
  app.get('/api/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'POST JSON-RPC to this URL (MCP streamable HTTP, stateless)' }));
}

configure();

module.exports = { configure, getUsage, mount, runCalc, catalogList, getSchema };
