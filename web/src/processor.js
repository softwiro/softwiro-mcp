// A2UI 1.0 message processor for the renderer: keeps surfaces (components + data model) and applies
// agent-to-renderer messages. Spec: https://a2ui.org/specification/v1.0-a2ui/
// Messages: { version: "1.0", <exactly one of> createSurface | updateComponents | updateDataModel | deleteSurface }
export const VERSION = '1.0';
export const SUPPORTED_CATALOGS = ['https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json'];
const KEYS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];

// RFC 6901 JSON Pointer helpers over plain objects
const parts = p => (p === '' || p === '/' || p === undefined ? [] : String(p).split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')));
export function getPointer(model, p) {
  let cur = model;
  for (const k of parts(p)) { if (cur === null || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}
function setPointer(model, p, value) {
  const ks = parts(p);
  if (!ks.length) return value === null ? {} : value;
  let cur = model;
  ks.slice(0, -1).forEach(k => { if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; });
  const last = ks[ks.length - 1];
  if (value === null) delete cur[last]; else cur[last] = value;
  return model;
}

export class Processor {
  constructor() { this.surfaces = new Map(); this.listeners = new Set(); this.errors = []; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach(f => f()); }
  error(code, message, surfaceId) { this.errors.push({ code, message, surfaceId }); if (this.errors.length > 50) this.errors.shift(); }

  // Accepts one message or an array; invalid messages are reported and skipped, never thrown
  process(input) {
    (Array.isArray(input) ? input : [input]).forEach(m => this.one(m));
    this.emit();
  }
  one(m) {
    if (!m || typeof m !== 'object' || m.version !== VERSION) return this.error('VALIDATION_FAILED', 'version must be "1.0"');
    const keys = Object.keys(m).filter(k => k !== 'version');
    if (keys.length !== 1) return this.error('VALIDATION_FAILED', 'a message has exactly one operation');
    const k = keys[0], b = m[k];
    if (k === 'error') return this.error(b && b.code, b && b.message, b && b.surfaceId);
    if (!KEYS.includes(k) || !b || typeof b.surfaceId !== 'string') return this.error('VALIDATION_FAILED', 'unsupported or malformed message: ' + k);
    const id = b.surfaceId;
    if (k === 'createSurface') {
      if (this.surfaces.has(id)) return this.error('INTEGRITY_ERROR', 'surface exists', id);
      if (b.catalogId && !SUPPORTED_CATALOGS.includes(b.catalogId)) return this.error('VALIDATION_FAILED', 'catalog not supported', id);
      const s = { id, components: new Map(), model: b.dataModel && typeof b.dataModel === 'object' ? structuredClone(b.dataModel) : {}, v: 0 };
      this.surfaces.set(id, s);
      (b.components || []).forEach(c => c && c.id && s.components.set(c.id, c));
    } else {
      const s = this.surfaces.get(id);
      if (!s) return this.error('INTEGRITY_ERROR', 'unknown surface', id);
      if (k === 'updateComponents') (b.components || []).forEach(c => c && c.id && s.components.set(c.id, c));
      else if (k === 'updateDataModel') s.model = setPointer(s.model, b.path, b.value === undefined ? null : structuredClone(b.value));
      else if (k === 'deleteSurface') this.surfaces.delete(id);
    }
    const s = this.surfaces.get(id); if (s) s.v += 1;
  }
}

// ---- dynamic values: literal | { "@path" } | { "@call", args } ----
const FUNCS = {
  // "Hello ${/user/name}" -> interpolated text; only absolute/relative paths are read, nothing is evaluated
  formatString: (args, get) => String(args.value ?? '').replace(/\$\{([^}]*)\}/g, (_, p) => { const v = get(p.trim()); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }),
  required: args => args.value !== undefined && args.value !== null && args.value !== '' && !(Array.isArray(args.value) && !args.value.length),
  not: args => !args.value, and: args => (args.values || []).every(Boolean), or: args => (args.values || []).some(Boolean),
};
export function resolve(value, model, scope) {
  const get = p => getPointer(model, scope && p[0] !== '/' ? scope + '/' + p : p);
  const go = v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('@path' in v) return get(String(v['@path']));
      if ('@call' in v) { const f = FUNCS[v['@call']]; if (!f) return undefined; const args = {}; Object.keys(v.args || {}).forEach(k => { args[k] = go(v.args[k]); }); return f(args, get); }
      const o = {}; Object.keys(v).forEach(k => { o[k] = go(v[k]); }); return o;
    }
    if (Array.isArray(v)) return v.map(go);
    return v;
  };
  return go(value);
}
