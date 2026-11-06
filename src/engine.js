// The calculation core of the online templates: loads a workbook (ExcelJS), evaluates its
// formulas on demand and keeps the edited values. No DOM here, so Node can test it against
// the reference values the Python builders already trust (pycel).
const FormulaParser = require('fast-formula-parser');
const { FormulaError, DepParser } = FormulaParser;

// Excel treats an empty cell as "" next to text and as 0 next to a number, and compares
// text without regard to case; the library does neither
const Ops = require('fast-formula-parser/formulas/operators');
const origCompare = Ops.Infix.compareOp;
Ops.Infix.compareOp = (a, op, b, ia, ib) => {
  if (!ia && !ib) {
    if (a == null && typeof b === 'string') a = '';
    if (b == null && typeof a === 'string') b = '';
    if (typeof a === 'string' && typeof b === 'string') { a = a.toLowerCase(); b = b.toLowerCase(); }
  }
  return origCompare(a, op, b, ia, ib);
};

// A function that returns an empty cell (INDEX over a blank) must give back blank, not #NULL!
const origCheck = FormulaParser.FormulaHelpers.checkFunctionResult;
FormulaParser.FormulaHelpers.checkFunctionResult = r => (r === null ? null : origCheck.call(FormulaParser.FormulaHelpers, r));

// Excel rounds to 15 significant digits before ROUND/ROUNDUP, so 500/(1-20/100) is 625, not 625.0000000000001
const fix15 = x => Number(x.toPrecision(15));
const roundTo = (x, d, mode) => {
  x = fix15(x);
  const m = Math.pow(10, d);
  const y = fix15(Math.abs(x) * m);
  const r = mode === 'up' ? Math.ceil(y) : mode === 'down' ? Math.floor(y) : Math.floor(y + 0.5);
  return Math.sign(x) * r / m;
};

const EPOCH = Date.UTC(1899, 11, 30);
const toSerial = d => (d.getTime() - EPOCH) / 86400000;
const fromSerial = n => new Date(EPOCH + Math.round(n * 86400000));
const key = (r, c) => r * 20000 + c;

// ---- Excel's criteria language (">0", "<>x", "C0*", "?*", 5) for the *IF(S) functions
function parseCriteria(c) {
  if (typeof c === 'number' || typeof c === 'boolean') return { op: '=', val: c, isNum: typeof c === 'number' };
  c = c == null ? '' : String(c);
  const m = c.match(/^(<=|>=|<>|=|<|>)([\s\S]*)$/);
  const op = m ? m[1] : '=';
  const rest = m ? m[2] : c;
  const num = rest.trim() !== '' && !isNaN(Number(rest)) ? Number(rest) : null;
  const val = num !== null ? num : rest;
  return { op, val, isNum: num !== null, wild: num === null && /[?*]/.test(rest), re: null, low: num === null ? String(rest).toLowerCase() : '' };
}
function cmp(a, op, b) {
  switch (op) {
    case '=': return a === b;
    case '<>': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
  }
  return false;
}
function wildcardRe(p) {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]') + '$', 'i');
}
function matches(value, k) {
  if (value instanceof FormulaError) return false;
  if (k.isNum) {
    if (typeof value === 'number') return cmp(value, k.op, k.val);
    if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value)) && (k.op === '=' || k.op === '<>')) return cmp(Number(value), k.op, k.val);
    return k.op === '<>';
  }
  const s = value == null ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  const t = String(k.val);
  if (k.wild) {
    if (!k.re) k.re = wildcardRe(t);
    const hit = k.re.test(s);
    return k.op === '<>' ? !hit : hit;
  }
  if (k.op === '=' || k.op === '<>') {
    if (t === '') return k.op === '=' ? s === '' : s !== '';
    if (typeof value === 'number') return k.op === '<>';
    return cmp(s.toLowerCase(), k.op, k.low);
  }
  if (typeof value === 'number') return false;
  return cmp(s.toLowerCase(), k.op, k.low);
}
// The library hands SUMIF/AVERAGEIF/INDEX raw references; ours want values, so those three
// are called under another name
const rewrite = f => f.replace(/\b(SUMIF|AVERAGEIF|INDEX|CHOOSE)\(/g, 'X$1(');

const REF = /(?<![\w.$])(?:(?:'((?:[^']|'')+)'|([A-Za-z_\u0600-\u06FF][\w.\u0600-\u06FF]*))!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?(?![\w(])/g;
const a1 = ref => {
  const m = ref.replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return { row: +m[2], col };
};

function extractRefs(f, sheet) {
  const deps = [];
  const text = f.replace(/"(?:[^"]|"")*"/g, '""');
  REF.lastIndex = 0;
  let m;
  while ((m = REF.exec(text))) {
    const sh = m[1] ? m[1].replace(/''/g, "'") : (m[2] || sheet);
    const a = a1(m[3]);
    if (m[4]) { const b = a1(m[4]); deps.push({ sheet: sh, from: { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) }, to: { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) } }); }
    else deps.push({ sheet: sh, row: a.row, col: a.col });
  }
  return deps;
}

const flatCache = new WeakMap();
const flat = a => {
  if (!Array.isArray(a)) return [a];
  let f = flatCache.get(a);
  if (!f) { f = a.length && Array.isArray(a[0]) ? (a[0].length === 1 ? a.map(r => r[0]) : a.flat()) : a; flatCache.set(a, f); }
  return f;
};
function ifsRows(pairs) {
  // pairs: [[range, criteria], ...] → indexes where every criterion holds
  const ranges = pairs.map(([r]) => flat(r));
  const ks = pairs.map(([, c]) => parseCriteria(Array.isArray(c) ? flat(c)[0] : c));
  const n = ranges[0].length;
  const rows = [];
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (let j = 0; j < ranges.length && ok; j++) ok = matches(ranges[j][i], ks[j]);
    if (ok) rows.push(i);
  }
  return rows;
}
const pairsOf = args => { const p = []; for (let i = 0; i < args.length; i += 2) p.push([args[i], args[i + 1]]); return p; };
const nums = (range, rows) => { const v = flat(range); return rows.map(i => v[i]).filter(x => typeof x === 'number'); };

// The parser hands custom functions {value, isArray, isRangeRef, ...} wrappers
const unwrap = a => (a && typeof a === 'object' && 'isArray' in a && 'value' in a ? (a.omitted ? undefined : a.value) : a);
const wrapAll = fns => Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, (...args) => f(...args.map(unwrap))]));

// Numbers for MIN/MAX/SMALL/LARGE: inside a reference only real numbers count
const numbersOf = args => {
  const out = [];
  for (const a of args) {
    if (a instanceof FormulaError) throw a;
    if (Array.isArray(a)) a.flat().forEach(v => { if (v instanceof FormulaError) throw v; if (typeof v === 'number') out.push(v); });
    else if (typeof a === 'number') out.push(a);
    else if (typeof a === 'boolean') out.push(a ? 1 : 0);
  }
  return out;
};
const kth = (args, k, asc) => {
  const v = numbersOf([args]).sort((a, b) => (asc ? a - b : b - a));
  return Number.isInteger(Number(k)) && k >= 1 && k <= v.length ? v[k - 1] : FormulaError.NUM;
};

// YEAR/MONTH/DAY over a serial date; an empty cell is serial 0 (1900-01-00) as in Excel
const dateParts = x => {
  if (x instanceof FormulaError) throw x;
  if (Array.isArray(x)) x = x.flat()[0];
  if (x === null || x === undefined || x === '') x = 0;
  if (typeof x === 'boolean') x = x ? 1 : 0;
  if (typeof x !== 'number') throw FormulaError.VALUE;
  if (x < 0) throw FormulaError.NUM;
  if (x < 1) return { y: 1900, m: 1, d: 0 };
  const d = fromSerial(Math.floor(x));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

const timeParts = x => {
  if (x instanceof FormulaError) throw x;
  if (Array.isArray(x)) x = x.flat()[0];
  if (x === null || x === undefined || x === '') x = 0;
  if (typeof x === 'string') {
    const m = x.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) throw FormulaError.VALUE;
    x = (+m[1] * 3600 + +m[2] * 60 + +(m[3] || 0)) / 86400;
  }
  if (typeof x === 'boolean') x = x ? 1 : 0;
  if (typeof x !== 'number') throw FormulaError.VALUE;
  if (x < 0) throw FormulaError.NUM;
  const secs = Math.round((x - Math.floor(x)) * 86400);
  return { h: Math.floor(secs / 3600) % 24, m: Math.floor(secs / 60) % 60, s: secs % 60 };
};

const STOCK_DATE = require('fast-formula-parser/formulas/functions/date');
// EDATE/EOMONTH: the stock ones throw a plain Error on an empty cell even in the branch IF does not take
const safeMonths = fn => (d, m) => {
  const one = v => (Array.isArray(v) ? v.flat()[0] : v);
  d = one(d); m = one(m);
  if (d instanceof FormulaError) throw d;
  if (m instanceof FormulaError) throw m;
  if (typeof d !== 'number' || typeof m !== 'number') throw FormulaError.VALUE;
  return STOCK_DATE[fn](d, m);
};

const RAW = {
  EDATE: safeMonths('EDATE'),
  EOMONTH: safeMonths('EOMONTH'),
  // A blank cell is not a number (the stock ISNUMBER counts it as 0)
  ISNUMBER: x => typeof x === 'number',
  // HOUR/MINUTE/SECOND: the stock ones throw on an empty cell even in the branch IF does not take
  HOUR: x => timeParts(x).h,
  MINUTE: x => timeParts(x).m,
  SECOND: x => timeParts(x).s,
  YEAR: x => dateParts(x).y,
  MONTH: x => dateParts(x).m,
  DAY: x => dateParts(x).d,
  XCHOOSE: (i, ...vals) => {
    if (i instanceof FormulaError) return i;
    const n = Math.floor(Number(i));
    if (!(n >= 1 && n <= vals.length)) return FormulaError.VALUE;
    const v = vals[n - 1];
    return v === undefined || v === null ? '' : v;
  },
  ROUND: (x, d) => roundTo(Number(x), Number(d || 0), 'half'),
  ROUNDUP: (x, d) => roundTo(Number(x), Number(d || 0), 'up'),
  ROUNDDOWN: (x, d) => roundTo(Number(x), Number(d || 0), 'down'),
  MIN: (...a) => { const v = numbersOf(a); return v.length ? Math.min(...v) : 0; },
  MAX: (...a) => { const v = numbersOf(a); return v.length ? Math.max(...v) : 0; },
  SMALL: (arr, k) => kth(arr, k, true),
  LARGE: (arr, k) => kth(arr, k, false),
  XINDEX: (arr, row, col) => {
    if (row instanceof FormulaError) return row;
    if (col instanceof FormulaError) return col;
    if (arr instanceof FormulaError) return arr;
    const g = Array.isArray(arr) ? arr : [[arr]];
    if (!g.length || !Array.isArray(g[0])) return FormulaError.REF;
    const rows = g.length, cols = g[0].length;
    let r = row == null ? 0 : Number(row), c = col == null ? 0 : Number(col);
    if (cols === 1 && col == null) { c = 1; }
    else if (rows === 1 && col == null) { c = r; r = 1; }
    if (r < 1 || r > rows || c < 1 || c > cols) return FormulaError.REF;
    const v = g[r - 1][c - 1];
    return v === undefined || v === null ? "" : v;
  },
  MATCH: (lookup, range, type) => {
    const list = flat(range);
    const t = type === undefined || type === null ? 1 : Number(type);
    if (Array.isArray(lookup)) lookup = flat(lookup)[0];
    if (t === 0) {
      const text = lookup == null ? '' : String(lookup);
      const k = typeof lookup === 'number' ? { op: '=', val: lookup, isNum: true } : { op: '=', val: text, isNum: false, wild: /[?*]/.test(text), re: null, low: text.toLowerCase() };
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (k.isNum ? v === k.val : (typeof v === 'string' && matches(v, k))) return i + 1;
      }
      return FormulaError.NA;
    }
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v == null || typeof v !== typeof lookup) continue;
      if (t === 1 ? v <= lookup : v >= lookup) best = i; else if (best >= 0) break;
    }
    return best >= 0 ? best + 1 : FormulaError.NA;
  },
  // The library ships SUMIFS/COUNTIFS/AVERAGEIFS as stubs, so these replace its set
  SUMIFS: (sum, ...rest) => nums(sum, ifsRows(pairsOf(rest))).reduce((a, b) => a + b, 0),
  COUNTIFS: (...args) => ifsRows(pairsOf(args)).length,
  AVERAGEIFS: (avg, ...rest) => {
    const v = nums(avg, ifsRows(pairsOf(rest)));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : FormulaError.DIV0;
  },
  XSUMIF: (range, crit, sum) => nums(sum === undefined ? range : sum, ifsRows([[range, crit]])).reduce((a, b) => a + b, 0),
  COUNTIF: (range, crit) => ifsRows([[range, crit]]).length,
  XAVERAGEIF: (range, crit, avg) => {
    const v = nums(avg === undefined ? range : avg, ifsRows([[range, crit]]));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : FormulaError.DIV0;
  },
};

class Book {
  constructor(wb) {
    this.wb = wb;
    this.sheets = [];
    this.byName = new Map();
    wb.eachSheet(ws => {
      const s = { name: ws.name, ws, cells: new Map(), maxRow: 0, maxCol: 0 };
      ws.eachRow({ includeEmpty: false }, (row, r) => {
        row.eachCell({ includeEmpty: false }, (cell, c) => {
          let v = cell.value;
          let f = null;
          if (v && typeof v === 'object' && !(v instanceof Date)) {
            if ('formula' in v || 'sharedFormula' in v) { f = v.formula || cell.formula || null; v = null; }
            else if (v.richText) v = v.richText.map(t => t.text).join('');
            else if ('text' in v) v = v.text;
            else if ('error' in v) v = new FormulaError(v.error);
            else v = null;
          }
          if (v instanceof Date) v = toSerial(v);
          if (f === null && (v === null || v === '')) return;
          s.cells.set(key(r, c), { v, f, dateLike: cell.value instanceof Date });
          s.maxRow = Math.max(s.maxRow, r);
          s.maxCol = Math.max(s.maxCol, c);
        });
      });
      this.sheets.push(s);
      this.byName.set(ws.name, s);
    });
    this.cache = new Map();
    this.rangeCache = new Map();
    this.busy = new Set();
    this.deps = new Map();
    this.ready = new Set();
    this.depParser = new DepParser();
    this.parser = new FormulaParser({
      onCell: ref => this.cellValue(ref.sheet, ref.row, ref.col),
      onRange: ref => this.rangeValues(ref.sheet, ref.from, ref.to),
      functions: wrapAll(RAW),
    });
  }

  entry(sheet, r, c) {
    const s = this.byName.get(sheet);
    return s ? s.cells.get(key(r, c)) : undefined;
  }

  cellValue(sheet, r, c) {
    if (!this.byName.has(sheet)) return FormulaError.REF;
    const e = this.entry(sheet, r, c);
    if (!e) return null;
    if (!e.f) return e.v;
    return this.compute(sheet, r, c, e);
  }

  rangeValues(sheet, from, to) {
    const k = `${sheet}|${from.row}|${from.col}|${to.row}|${to.col}`;
    let out = this.rangeCache.get(k);
    if (out) return out;
    out = [];
    for (let r = from.row; r <= to.row; r++) {
      const row = [];
      for (let c = from.col; c <= to.col; c++) row.push(this.cellValue(sheet, r, c));
      out.push(row);
    }
    this.rangeCache.set(k, out);
    return out;
  }

  compute(sheet, r, c, e) {
    const ck = sheet + '|' + key(r, c);
    if (this.cache.has(ck)) return this.cache.get(ck);
    if (this.busy.has(ck)) return FormulaError.REF; // circular
    this.busy.add(ck);
    let v;
    try {
      // The parser cannot be re-entered, so everything this formula reads is calculated
      // first and the parse itself only ever meets cached values
      this.resolveDeps(sheet, r, c, e);
      v = this.parser.parse(rewrite(e.f), { sheet, row: r, col: c });
      if (Array.isArray(v)) v = Array.isArray(v[0]) ? v[0][0] : v[0];
      if (v === undefined) v = null;
    } catch (err) {
      v = err instanceof FormulaError ? err : new FormulaError('#VALUE!');
    }
    this.busy.delete(ck);
    this.cache.set(ck, v);
    return v;
  }

  // References a formula reads, from its text (string literals removed first)
  refsOf(sheet, r, c, e) {
    const dk = sheet + '|' + key(r, c);
    let deps = this.deps.get(dk);
    if (!deps) this.deps.set(dk, deps = extractRefs(e.f, sheet));
    return deps;
  }

  resolveDeps(sheet, r, c, e) {
    for (const d of this.refsOf(sheet, r, c, e)) {
      const s = this.byName.get(d.sheet);
      if (!s) continue;
      if (d.from) {
        const rk = `${d.sheet}|${d.from.row}|${d.from.col}|${d.to.row}|${d.to.col}`;
        if (this.ready.has(rk)) continue;
        this.ready.add(rk);
        const r1 = Math.min(d.to.row, Math.max(s.maxRow, d.from.row)), c1 = Math.min(d.to.col, Math.max(s.maxCol, d.from.col));
        for (let rr = d.from.row; rr <= r1; rr++) for (let cc = d.from.col; cc <= c1; cc++) {
          const en = s.cells.get(key(rr, cc));
          if (en && en.f) this.compute(d.sheet, rr, cc, en);
        }
      } else {
        const en = s.cells.get(key(d.row, d.col));
        if (en && en.f) this.compute(d.sheet, d.row, d.col, en);
      }
    }
  }

  // Who reads what: built once, on the first edit (or when exporting values), so an edit
  // clears only the cells that depend on it instead of the whole workbook
  buildGraph() {
    if (this.graph) return this.graph;
    const cellDeps = new Map();   // "sheet|key" -> [dependent ids]
    const ranges = new Map();     // range key -> { sheet, from, to, deps: [ids] }
    for (const s of this.sheets) {
      s.cells.forEach((e, k) => {
        if (!e.f) return;
        const r = Math.floor(k / 20000), c = k % 20000;
        const id = s.name + '|' + k;
        for (const d of this.refsOf(s.name, r, c, e)) {
          if (d.from) {
            const rk = `${d.sheet}|${d.from.row}|${d.from.col}|${d.to.row}|${d.to.col}`;
            let g = ranges.get(rk);
            if (!g) ranges.set(rk, g = { sheet: d.sheet, from: d.from, to: d.to, deps: [] });
            g.deps.push(id);
          } else {
            const ik = d.sheet + '|' + key(d.row, d.col);
            let l = cellDeps.get(ik);
            if (!l) cellDeps.set(ik, l = []);
            l.push(id);
          }
        }
      });
    }
    const bySheet = new Map();
    ranges.forEach((g, rk) => { g.rk = rk; if (!bySheet.has(g.sheet)) bySheet.set(g.sheet, []); bySheet.get(g.sheet).push(g); });
    return (this.graph = { cellDeps, bySheet });
  }

  // Every formula cell that reads (directly or not) the given starting cells
  dependentsOf(starts, { clear = false } = {}) {
    const { cellDeps, bySheet } = this.buildGraph();
    const seen = new Set();
    const queue = [...starts];
    while (queue.length) {
      const id = queue.pop();
      const i = id.lastIndexOf('|');
      const sheet = id.slice(0, i), k = +id.slice(i + 1);
      const r = Math.floor(k / 20000), c = k % 20000;
      const next = [];
      (cellDeps.get(id) || []).forEach(x => next.push(x));
      (bySheet.get(sheet) || []).forEach(g => {
        if (r >= g.from.row && r <= g.to.row && c >= g.from.col && c <= g.to.col) {
          g.deps.forEach(x => next.push(x));
          if (clear) { this.rangeCache.delete(g.rk); this.ready.delete(g.rk); }
        }
      });
      for (const x of next) if (!seen.has(x)) { seen.add(x); queue.push(x); }
    }
    return seen;
  }

  // A conditional-format rule: does this formula hold for the cell at (r, c)?
  test(sheet, formula, r, c) {
    try {
      for (const d of extractRefs(formula, sheet)) {
        const s = this.byName.get(d.sheet);
        if (!s) continue;
        if (d.from) {
          const r1 = Math.min(d.to.row, Math.max(s.maxRow, d.from.row)), c1 = Math.min(d.to.col, Math.max(s.maxCol, d.from.col));
          for (let rr = d.from.row; rr <= r1; rr++) for (let cc = d.from.col; cc <= c1; cc++) {
            const en = s.cells.get(key(rr, cc));
            if (en && en.f) this.compute(d.sheet, rr, cc, en);
          }
        } else {
          const en = s.cells.get(key(d.row, d.col));
          if (en && en.f) this.compute(d.sheet, d.row, d.col, en);
        }
      }
      const v = this.parser.parse(rewrite(formula), { sheet, row: r, col: c });
      return v === true || (typeof v === 'number' && v !== 0);
    } catch (err) { return false; }
  }

  // The value shown for a cell
  get(sheet, r, c) { return this.cellValue(sheet, r, c); }
  isFormula(sheet, r, c) { const e = this.entry(sheet, r, c); return !!(e && e.f); }
  raw(sheet, r, c) { const e = this.entry(sheet, r, c); return e ? (e.f ? '=' + e.f : e.v) : null; }

  set(sheet, r, c, v) {
    const s = this.byName.get(sheet);
    if (!s) return;
    if (v === null || v === undefined || v === '') s.cells.delete(key(r, c));
    else {
      s.cells.set(key(r, c), { v, f: null });
      s.maxRow = Math.max(s.maxRow, r);
      s.maxCol = Math.max(s.maxCol, c);
    }
    const dirty = this.dependentsOf([sheet + '|' + key(r, c)], { clear: true });
    dirty.forEach(id => this.cache.delete(id));
  }

  invalidate() { this.cache.clear(); this.rangeCache.clear(); this.ready.clear(); }

  // Values of every formula that does not depend on today's date, for shipping with the
  // template so the page opens without calculating the whole workbook. Formulas that read
  // TODAY() (directly or through others) are listed so the page calculates those itself.
  exportValues() {
    const volatile = [];
    for (const s of this.sheets) s.cells.forEach((e, k) => { if (e.f && /\b(TODAY|NOW)\s*\(/i.test(e.f)) volatile.push(s.name + '|' + k); });
    const skip = this.dependentsOf(volatile);
    volatile.forEach(x => skip.add(x));
    const values = {}, vol = {};
    for (const s of this.sheets) {
      const vals = {}, vl = [];
      s.cells.forEach((e, k) => {
        if (!e.f) return;
        if (skip.has(s.name + '|' + k)) { vl.push(k); return; }
        let v = this.compute(s.name, Math.floor(k / 20000), k % 20000, e);
        if (v instanceof FormulaError) v = { err: v.error };
        if (v === '' || v === null) return; // blank is the default for a preloaded formula
        vals[k] = v;
      });
      values[s.name] = vals;
      if (vl.length) vol[s.name] = vl;
    }
    return { values, volatile: vol };
  }

  preload(pack) {
    for (const s of this.sheets) {
      const vals = pack.values[s.name] || {};
      const vol = new Set(pack.volatile[s.name] || []);
      s.cells.forEach((e, k) => {
        if (!e.f || vol.has(k)) return;
        const v = vals[k];
        this.cache.set(s.name + '|' + k, v === undefined ? '' : (v && v.err ? new FormulaError(v.err) : v));
      });
    }
  }

  // The last row holding a typed (non-formula) value: the end of the data you enter
  lastInputRow(sheet) {
    const s = this.byName.get(sheet);
    let last = 0;
    s.cells.forEach((e, k) => { if (!e.f) last = Math.max(last, Math.floor(k / 20000)); });
    return last;
  }
}

module.exports = { Book, toSerial, fromSerial, key, FormulaError, parseCriteria, matches };
