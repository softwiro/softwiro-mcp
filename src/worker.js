// Runs ONE calculation in an isolated worker thread: loads the template workbook, writes the
// caller's values into the input cells, reads the requested cells. Nothing is stored anywhere.
// The parent kills this thread after a timeout, so a bad request cannot hang the website.
const { parentPort, workerData } = require('worker_threads');
const ENGINE = require('path').join(__dirname, 'engine.js');
const EXCELJS = 'exceljs';

const colNum = s => { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
const colLetter = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

(async () => {
  const ExcelJS = require(EXCELJS);
  const { Book, FormulaError, toSerial, key } = require(ENGINE);
  const { file, schema, req } = workerData;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const book = new Book(wb);
  // Writing many cells one by one through book.set walks the dependency graph for every cell (about 30 ms each on
  // a big template: clearing 500 members took minutes and the request timed out). Here the cells are written
  // directly and the engine's caches are dropped once, before anything is read.
  const put = (sheet, r, c, v) => {
    const sh = book.byName.get(sheet);
    if (!sh) return;
    if (v === null || v === undefined || v === '') sh.cells.delete(key(r, c));
    else {
      sh.cells.set(key(r, c), { v, f: null });
      sh.maxRow = Math.max(sh.maxRow, r);
      sh.maxCol = Math.max(sh.maxCol, c);
    }
  };
  const warnings = [];
  const norm = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? toSerial(new Date(v + 'T00:00:00Z')) : v;
  const out = v => v instanceof FormulaError ? { error: v.error } : (v === undefined ? null : v);
  const addr = a => {
    const i = a.lastIndexOf('!');
    const sheet = a.slice(0, i), m = a.slice(i + 1).match(/^([A-Z]+)(\d+)$/);
    if (i < 1 || !m || !book.byName.has(sheet)) return null;
    return { sheet, r: +m[2], c: colNum(m[1]) };
  };

  const written = [];
  for (const rec of req.records || []) {
    const sh = (schema.sheets || []).find(s => s.name === rec.sheet);
    const t = sh && (sh.record_tables || [])[rec.table || 0];
    if (!t) throw Object.assign(new Error(`no record table ${rec.table || 0} on sheet "${rec.sheet}" (see the schema)`), { code: 400 });
    const inputs = t.columns.filter(c => c.kind === 'input');
    const byKey = new Map();
    t.columns.forEach(c => { byKey.set(c.header, c); byKey.set(c.column, c); });
    const first = t.first_record_row, last = t.capacity_last_row;
    const rows = rec.rows || [];
    if ((req.mode || 'replace') === 'replace') {
      for (let r = first; r <= last; r++) for (const c of inputs) put(rec.sheet, r, colNum(c.column), null);
    }
    let start = first;
    if (req.mode === 'append') {
      while (start <= last && inputs.some(c => book.get(rec.sheet, start, colNum(c.column)) !== null && book.get(rec.sheet, start, colNum(c.column)) !== '')) start++;
    }
    if (start + rows.length - 1 > last) throw Object.assign(new Error(`table "${rec.sheet}" has room for ${last - first + 1} rows`), { code: 400 });
    rows.forEach((row, i) => {
      for (const [k, v] of Object.entries(row)) {
        const col = byKey.get(k);
        if (!col) { warnings.push(`unknown column "${k}" in ${rec.sheet}`); continue; }
        if (col.kind !== 'input') { warnings.push(`column "${k}" is calculated and was ignored`); continue; }
        put(rec.sheet, start + i, colNum(col.column), norm(v));
      }
      written.push({ sheet: rec.sheet, row: start + i, t });
    });
  }

  for (const [a, v] of Object.entries(req.cells || {})) {
    const p = addr(a);
    if (!p) throw Object.assign(new Error(`bad cell address "${a}" (use "Sheet name!B3")`), { code: 400 });
    if (book.isFormula(p.sheet, p.r, p.c)) { warnings.push(`${a} is a formula and was ignored`); continue; }
    put(p.sheet, p.r, p.c, norm(v));
  }

  book.invalidate();
  const results = [];
  const wanted = req.read;
  if (Array.isArray(wanted) && wanted.length) {
    for (const a of wanted) {
      const p = addr(a);
      if (!p) { warnings.push(`bad cell address "${a}"`); continue; }
      results.push({ cell: a, value: out(book.get(p.sheet, p.r, p.c)) });
    }
  } else {
    for (const sh of schema.sheets || []) for (const r of sh.results || []) {
      const m = r.cell.match(/^([A-Z]+)(\d+)$/);
      results.push({ sheet: sh.name, cell: r.cell, label: r.label, value: out(book.get(sh.name, +m[2], colNum(m[1]))) });
    }
  }

  const rows = written.map(w => {
    const values = {};
    for (const c of w.t.columns) {
      if (c.kind === 'formula') values[c.header] = out(book.get(w.sheet, w.row, colNum(c.column)));
    }
    return { sheet: w.sheet, row: w.row, calculated: values };
  });
  parentPort.postMessage({ ok: true, results, rows, warnings, dates: 'dates are Excel serial numbers (days since 1899-12-30)' });
})().catch(e => parentPort.postMessage({ ok: false, error: String(e.message || e), code: e.code || 500 }));
