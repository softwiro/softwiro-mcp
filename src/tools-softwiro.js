'use strict';
// Server-side port of the 13 free softwiro.com calculators (the browser scripts of the tool pages), for the MCP
// endpoint. The arithmetic, constants, rounding and edge-case rules are copied from the browser
// scripts; the Arabic wording of notes, categories and ranges comes from the tools' own page text
// (data/tool-text.json), so a warning here is the warning the page shows.
// Numbers come back rounded the way the page displays them (same Intl.NumberFormat), dates as
// YYYY-MM-DD computed in UTC. Nothing here touches the DOM, the network or the clock unless a
// date tool is run without its optional `today` input.
//
// exports: { list, run }

const path = require('path');
// The Arabic page text of each tool (notes, categories, ranges, titles), exported once from softwiro.com's tool pages
const TEXT = require(path.join(__dirname, '..', 'data', 'tool-text.json'));
function TX(id) { return TEXT[id].tx; }

// ---------- number formatting: the same formatters as common.client.js ----------
const FMT = {
  0: new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }),
  1: new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }),
  2: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  3: new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
};
// A number as the page prints it, read back as a number
function r(d, v) {
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('internal error: a result was not a finite number');
  return Number(FMT[d].format(v).replace(/,/g, '')) || 0;
}
const fm = (d, v) => FMT[d].format(v); // as text, for messages

// ---------- input reading ----------
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function has(v) { return v !== undefined && v !== null && String(v).trim() !== ''; }
// Like SwTool.num but strict: blank is 0 (the page's empty field); junk or a negative throws
function num(obj, key, label) {
  const name = label || key;
  const v = obj[key];
  if (!has(v)) return 0;
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const s = v.trim().replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d))).replace(/[٫,]/g, '.');
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) throw new Error(`${name} must be a number (got "${v}")`);
    n = parseFloat(s);
  } else throw new Error(`${name} must be a number`);
  if (!isFinite(n)) throw new Error(`${name} must be a finite number`);
  if (n < 0) throw new Error(`${name} must not be negative`);
  return n || 0;
}
function en(obj, key, allowed, def) {
  const v = obj[key];
  if (!has(v)) return def;
  const s = String(v);
  if (!allowed.map(String).includes(s)) throw new Error(`${key} must be one of: ${allowed.join(', ')} (got "${s}")`);
  return s;
}
function arr(obj, key, max, required) {
  const v = obj[key];
  if (v === undefined || v === null) { if (required) throw new Error(`${key} is required (an array)`); return []; }
  if (!Array.isArray(v)) throw new Error(`${key} must be an array`);
  if (required && !v.length) throw new Error(`${key} must have at least one entry`);
  if (v.length > max) throw new Error(`${key} can hold at most ${max} entries`);
  v.forEach((e, k) => { if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${key}[${k}] must be an object`); });
  return v;
}
function only(obj, allowed) {
  Object.keys(obj).forEach(k => { if (!allowed.includes(k)) throw new Error(`Unknown input "${k}". Allowed: ${allowed.join(', ')}`); });
}
const fill = (s, o) => s.replace(/\{(\w+)\}/g, (m, k) => (o[k] === undefined ? m : o[k]));

// ---------- dates, whole days counted in UTC ----------
const DAY = 864e5;
function dayNum(iso, label, min1900) {
  if (!has(iso)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) throw new Error(`${label} must be a date as YYYY-MM-DD (got "${iso}")`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (new Date(ms).toISOString().slice(0, 10) !== m[0]) throw new Error(`${label} is not a real calendar date ("${iso}")`);
  if (min1900 && +m[1] < 1900) return null;
  return ms / DAY;
}
function isoOf(n) { return new Date(n * DAY).toISOString().slice(0, 10); }
function todayNum(inputs) {
  if (has(inputs.today)) return dayNum(inputs.today, 'today');
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
}

// ===================================================================================
// 1. garment-cost
// ===================================================================================
const CUR4 = ['EGP', 'SAR', 'USD', 'EUR'];
const CUR_AED = ['EGP', 'SAR', 'AED', 'USD'];

function garmentCost(i) {
  only(i, ['consumption', 'unit', 'fabric_price', 'cutting_waste_pct', 'trims', 'packaging', 'outside_work', 'labor_mode', 'labor_per_piece', 'monthly_wages', 'monthly_overhead', 'monthly_output', 'reject_pct', 'target_margin_pct', 'selling_price', 'order_quantity', 'currency']);
  const T = TX('garment-cost');
  const n = k => num(i, k);
  const unit = en(i, 'unit', ['m', 'kg'], 'm');
  const currency = en(i, 'currency', CUR4, 'EGP');
  const byWages = en(i, 'labor_mode', ['piece', 'wages'], 'piece') === 'wages';

  const monthly = n('monthly_output');
  const fabric = n('consumption') * n('fabric_price') * (1 + n('cutting_waste_pct') / 100);
  const trims = n('trims') + n('packaging');
  const outside = n('outside_work');
  const labor = byWages ? (monthly ? n('monthly_wages') / monthly : 0) : n('labor_per_piece');
  const overhead = monthly ? n('monthly_overhead') / monthly : 0;
  const base = fabric + trims + outside + labor + overhead;
  const reject = Math.min(n('reject_pct'), 90) / 100;
  const total = base / (1 - reject);
  const parts = { fabric, trims_and_packaging: trims, outside_work: outside, labor, overhead, reject_allowance: total - base };

  const notes = [];
  if ((n('monthly_overhead') || (byWages && n('monthly_wages'))) && !monthly) notes.push(T.notes.monthly);
  if (n('reject_pct') > 90) notes.push(T.notes.reject);

  const out = { currency, unit, cost_per_piece: r(2, total), breakdown: {} };
  Object.keys(parts).forEach(k => {
    const share = total ? (parts[k] / total) * 100 : 0;
    out.breakdown[k] = { amount: r(2, parts[k]), share_pct: total ? r(0, share) : null };
  });

  const margin = n('target_margin_pct');
  if (margin >= 100) notes.push(T.notes.margin);
  const suggested = margin > 0 && margin < 100 ? total / (1 - margin / 100) : 0;
  out.suggested_price = null;
  if (suggested && total) {
    out.suggested_price = { price: r(2, suggested), profit_per_piece: r(2, suggested - total), markup_on_cost_pct: r(0, ((suggested - total) / total) * 100) };
  }

  const price = n('selling_price');
  out.at_actual_price = null;
  if (price && total) {
    const profit = price - total;
    out.at_actual_price = { profit_per_piece: r(2, profit), margin_pct: r(2, (profit / price) * 100) };
    if (profit < 0) notes.push(T.notes.loss);
  }

  const qty = n('order_quantity');
  out.order = null;
  if (qty && total) {
    const produce = Math.ceil(qty / (1 - reject));
    const o = {
      pieces_to_produce_including_rejects: r(0, produce),
      fabric_needed: r(2, n('consumption') * (1 + n('cutting_waste_pct') / 100) * produce),
      fabric_unit: unit,
      order_cost: r(2, total * qty),
      sales_value: null,
      profit: null,
    };
    const sell = price || suggested;
    if (sell) { o.sales_value = r(2, sell * qty); o.profit = r(2, (sell - total) * qty); }
    out.order = o;
  }
  out.notes = notes;
  return out;
}

// ===================================================================================
// 2. fabric-consumption
// ===================================================================================
function fabricConsumption(i) {
  only(i, ['marker_length_m', 'pieces_per_marker', 'end_loss_cm', 'fabric_width_cm', 'gsm', 'extra_allowance_pct', 'order_quantity', 'reject_pct', 'unit']);
  const T = TX('fabric-consumption');
  const n = k => num(i, k);
  const byKg = en(i, 'unit', ['m', 'kg'], 'm') === 'kg';
  const marker = n('marker_length_m');
  const pieces = n('pieces_per_marker');
  const end = n('end_loss_cm') / 100;
  const extra = n('extra_allowance_pct') / 100;
  const kgPerM = (n('fabric_width_cm') / 100) * n('gsm') / 1000;
  const mPerPiece = pieces ? ((marker + end) / pieces) * (1 + extra) : 0;
  const kgPerPiece = mPerPiece * kgPerM;

  const notes = [];
  if (byKg && !kgPerM) notes.push(T.notes.kg);
  if (n('reject_pct') > 90) notes.push(T.notes.reject);

  const showKg = byKg && kgPerM;
  const out = {
    unit: showKg ? 'kg' : 'm',
    consumption_per_piece: r(3, showKg ? kgPerPiece : mPerPiece),
    meters_per_piece: r(3, mPerPiece),
    kg_per_piece: null,
    kg_per_meter: null,
    meters_per_kg: null,
    order: null,
  };
  if (kgPerM) {
    out.kg_per_piece = r(3, kgPerPiece);
    out.kg_per_meter = r(3, kgPerM);
    out.meters_per_kg = r(2, 1 / kgPerM);
  }
  const qty = n('order_quantity');
  if (qty && pieces && marker) {
    const reject = Math.min(n('reject_pct'), 90) / 100;
    const cut = Math.ceil(qty / (1 - reject));
    const plies = Math.ceil(cut / pieces);
    const totalM = plies * (marker + end) * (1 + extra);
    out.order = {
      pieces_to_cut: r(0, cut),
      plies: r(0, plies),
      pieces_actually_cut: r(0, plies * pieces),
      total_meters: r(2, totalM),
      total_kg: kgPerM ? r(2, totalM * kgPerM) : null,
    };
  }
  out.notes = notes;
  return out;
}

// ===================================================================================
// 3. break-even
// ===================================================================================
function breakEven(i) {
  only(i, ['rent', 'salaries', 'utilities', 'installments', 'other_fixed', 'price_per_unit', 'variable_cost_per_unit', 'target_profit', 'planned_units', 'working_days', 'currency']);
  const T = TX('break-even');
  const n = k => num(i, k);
  const currency = en(i, 'currency', CUR4, 'EGP');
  const fixed = n('rent') + n('salaries') + n('utilities') + n('installments') + n('other_fixed');
  const price = n('price_per_unit');
  const cm = price - n('variable_cost_per_unit');
  const days = n('working_days');
  const notes = [];
  const valid = price > 0 && cm > 0;
  if (price > 0 && cm <= 0) notes.push(T.notes.price);
  if (!price) throw new Error('price_per_unit is required (greater than 0) to compute a break-even point');

  const be = valid ? Math.ceil(fixed / cm) : 0;
  const out = {
    currency,
    break_even_units: valid ? r(0, be) : null,
    fixed_costs: r(2, fixed),
    contribution_per_unit: r(2, cm),
    contribution_ratio_pct: valid ? r(1, (cm / price) * 100) : null,
    break_even_sales: valid ? r(2, be * price) : null,
    break_even_units_per_day: valid && days ? r(0, Math.ceil(be / days)) : null,
    target_profit: null,
    planned: null,
  };
  const target = n('target_profit');
  if (valid && target) {
    const need = Math.ceil((fixed + target) / cm);
    out.target_profit = { units_needed: r(0, need), units_per_day: days > 0 ? r(0, Math.ceil(need / days)) : null };
  }
  const planned = n('planned_units');
  if (valid && planned) {
    const profit = planned * cm - fixed;
    out.planned = { profit: r(2, profit), safety_margin_pct: r(1, ((planned - be) / planned) * 100) };
    if (planned < be) notes.push(T.notes.below);
  }
  out.notes = notes;
  return out;
}

// ===================================================================================
// 4. piece-rate
// ===================================================================================
function pieceRate(i) {
  only(i, ['standard_minutes_per_piece', 'hours_per_day', 'workers', 'efficiency_pct', 'monthly_wage', 'working_days', 'actual_pieces_per_day', 'currency']);
  const T = TX('piece-rate');
  const n = k => num(i, k);
  const currency = en(i, 'currency', CUR4, 'EGP');
  const sam = n('standard_minutes_per_piece');
  const minutes = n('hours_per_day') * 60;
  const workers = n('workers') || 1;
  const eff = n('efficiency_pct') ? n('efficiency_pct') / 100 : 1;
  const valid = sam > 0 && minutes > 0;
  if (!valid) throw new Error('standard_minutes_per_piece and hours_per_day are required (each greater than 0)');
  const perDay = (minutes * eff) / sam;
  const notes = [];
  if (n('efficiency_pct') > 100) notes.push(T.notes.efficiency);

  const out = {
    currency,
    pieces_per_day: r(1, perDay),
    pieces_per_hour: r(1, perDay / (minutes / 60)),
    pieces_per_day_at_full_efficiency: r(1, minutes / sam),
    group_pieces_per_day: workers > 1 ? r(0, perDay * workers) : null,
    daily_wage: null,
    rate_per_piece: null,
    actual: null,
  };
  const wage = n('monthly_wage');
  const days = n('working_days');
  const daily = wage && days ? wage / days : 0;
  const rate = daily && perDay ? daily / perDay : 0;
  if (rate) { out.daily_wage = r(2, daily); out.rate_per_piece = r(2, rate); }
  const actual = n('actual_pieces_per_day');
  if (actual) {
    out.actual = {
      efficiency_pct: r(1, (actual * sam / minutes) * 100),
      monthly_earnings: rate && days ? r(2, actual * rate * days) : null,
    };
  }
  out.notes = notes;
  return out;
}

// ===================================================================================
// 5. vat-calculator
// ===================================================================================
// Each line rounded to two decimals before the lines are added up, as on an invoice
function round2(v) { return Math.round(v * 100 + 1e-7) / 100; }
function vat(i) {
  only(i, ['country', 'rate_pct', 'mode', 'currency', 'lines']);
  const T = TX('vat-calculator');
  const country = en(i, 'country', ['eg', 'sa', 'ae', 'other'], 'eg');
  const mode = en(i, 'mode', ['add', 'extract'], 'add');
  const CURRENCY_OF = { eg: 'EGP', sa: 'SAR', ae: 'AED' };
  const currency = en(i, 'currency', CUR_AED, CURRENCY_OF[country] || 'EGP');
  const other = country === 'other';
  const rate = other ? num(i, 'rate_pct') : T.rates[country];
  const notes = [];
  if (other && !rate) throw new Error('rate_pct: ' + T.notes.rate);
  if (rate > 100) notes.push(T.notes.rateHigh);
  const rows = arr(i, 'lines', T.rows, true);
  const lines = [];
  rows.forEach((row, k) => {
    only(row, ['price', 'quantity']);
    const price = num(row, 'price', `lines[${k}].price`);
    if (!price) return;
    const qty = has(row.quantity) ? num(row, 'quantity', `lines[${k}].quantity`) : 1;
    const amount = round2(price * qty);
    const tax = mode === 'add' ? round2(amount * rate / 100) : round2(amount * rate / (100 + rate));
    const net = mode === 'add' ? amount : round2(amount - tax);
    lines.push({ n: k + 1, net, tax, gross: round2(net + tax) });
  });
  if (!lines.length) throw new Error('lines: at least one line needs a price greater than 0');
  const sum = k => round2(lines.reduce((s, l) => s + l[k], 0));
  const last = { net: sum('net'), tax: sum('tax'), gross: sum('gross') };
  return {
    currency, country, mode, rate_pct: r(1, rate),
    headline: mode === 'add' ? { label: T.big.add, amount: r(2, last.gross) } : { label: T.big.extract, amount: r(2, last.tax) },
    net: r(2, last.net), tax: r(2, last.tax), gross: r(2, last.gross),
    lines: lines.length > 1 ? lines.map(l => ({ n: l.n, net: r(2, l.net), tax: r(2, l.tax), gross: r(2, l.gross) })) : null,
    notes,
  };
}

// ===================================================================================
// 6. study-schedule
// ===================================================================================
function studySchedule(i) {
  only(i, ['subjects', 'sessions_per_day', 'session_minutes', 'rest_day', 'start_date', 'first_session_time', 'today']);
  const T = TX('study-schedule');
  const MAX_DAYS = 120, MAX_SESSIONS = 12, BREAK = 15;
  const weekday = n => new Date(n * DAY).getUTCDay();
  const clock = min => {
    min = ((min % 1440) + 1440) % 1440;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return ((h + 11) % 12 + 1) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? T.am : T.pm);
  };
  const names = list => list.map(s => s.name).join(' / ');

  const len = +en(i, 'session_minutes', ['45', '60', '90', '120'], '60') || 60;
  let from = null;
  if (has(i.first_session_time)) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(i.first_session_time));
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('first_session_time must be HH:MM (24-hour)');
    from = +m[1] * 60 + +m[2];
  }
  const rest = en(i, 'rest_day', ['none', '0', '1', '2', '3', '4', '5', '6'], 'none');
  let N = Math.floor(num(i, 'sessions_per_day'));
  const subjectsIn = arr(i, 'subjects', T.rows, true);
  const list = [];
  subjectsIn.forEach((s, k) => {
    only(s, ['name', 'exam_date', 'difficulty']);
    const name = has(s.name) ? String(s.name).trim() : '';
    if (name.length > 40) throw new Error(`subjects[${k}].name is longer than 40 characters`);
    if (!name) return;
    const diff = en(s, 'difficulty', ['1', '2', '3'], '2');
    list.push({ i: list.length, name, exam: dayNum(s.exam_date, `subjects[${k}].exam_date`), w: +diff || 2, n: 0 });
  });
  if (!list.length) throw new Error('subjects: at least one subject needs a name');
  if (!N) throw new Error('sessions_per_day is required (a whole number of 1 or more)');
  const notes = [];
  if (N > MAX_SESSIONS) { N = MAX_SESSIONS; notes.push(T.notes.sessionsCap); }
  const exam = list.some(s => s.exam !== null);
  let start = dayNum(i.start_date, 'start_date');
  if (start === null) start = todayNum(i);

  // One session to the subject with the most credit; on a tie the nearer exam, then the
  // harder subject, then the one listed first
  function pick(pool, credit) {
    let best = null;
    pool.forEach(s => {
      if (!best) { best = s; return; }
      const a = credit[s.i];
      const b = credit[best.i];
      if (Math.abs(a - b) > 1e-9 ? a > b : s.exam !== best.exam ? s.exam < best.exam : s.w !== best.w ? s.w > best.w : s.i < best.i) best = s;
    });
    credit[best.i] -= 1;
    best.n += 1;
    return best;
  }
  function fillDay(pool, claim, count, credit) {
    const total = pool.reduce((sum, s) => sum + claim(s), 0);
    const picks = [];
    for (let k = 0; k < count; k += 1) {
      pool.forEach(s => { credit[s.i] = (credit[s.i] || 0) + claim(s) / total; });
      picks.push(pick(pool, credit));
    }
    return picks;
  }
  // A day's sessions in order: never the same subject twice running while another is left;
  // otherwise the subject with most sessions left, then the harder, then the one listed first
  function orderDay(picks) {
    const left = {};
    const subj = {};
    picks.forEach(s => { left[s.i] = (left[s.i] || 0) + 1; subj[s.i] = s; });
    const out = [];
    let prev = null;
    picks.forEach(() => {
      let best = null;
      Object.keys(left).forEach(key => {
        const s = subj[key];
        if (!left[key]) return;
        if (!best) { best = s; return; }
        const better = (s === prev) !== (best === prev) ? best === prev
          : left[key] !== left[best.i] ? left[key] > left[best.i]
            : s.w !== best.w ? s.w > best.w : s.i < best.i;
        if (better) best = s;
      });
      left[best.i] -= 1;
      out.push(best);
      prev = best;
    });
    return out;
  }
  function examPlan() {
    const pnotes = [];
    const dated = [];
    const undated = [];
    list.forEach(s => {
      if (s.exam === null) undated.push(s);
      else if (s.exam <= start) { s.out = true; pnotes.push(T.notes.past.replace('{name}', s.name)); }
      else dated.push(s);
    });
    if (!dated.length) return { rows: [], notes: pnotes };
    const last = Math.max.apply(null, dated.map(s => s.exam));
    if (undated.length) pnotes.push(T.notes.noDate);
    undated.forEach(s => { s.exam = last; });
    let end = last;
    if (last - start >= MAX_DAYS) { end = start + MAX_DAYS - 1; pnotes.push(T.notes.cap); }
    const pool = dated.concat(undated);
    const credit = {};
    const rows = [];
    for (let d = start; d <= end; d += 1) {
      const day = d;
      const exams = dated.filter(s => s.exam === day);
      const active = pool.filter(s => s.exam > day);
      const review = dated.filter(s => s.exam === day + 1);
      const count = exams.length ? Math.ceil(N / 2) : N;
      const row = { d, exams, kind: 'study', cells: [] };
      if (!active.length) row.kind = 'none';
      else if (review.length) {
        row.kind = 'review';
        review.sort((a, b) => b.w - a.w || a.i - b.i);
        for (let k = 0; k < count; k += 1) {
          review[k % review.length].n += 1;
          row.cells.push(review[k % review.length]);
        }
        row.cells = orderDay(row.cells);
      } else if (rest !== 'none' && weekday(d) === +rest) row.kind = 'rest';
      else row.cells = orderDay(fillDay(active, s => s.w / (s.exam - day), count, credit));
      rows.push(row);
    }
    return { rows, notes: pnotes };
  }
  function weekPlan() {
    const credit = {};
    const rows = [];
    for (let k = 0; k < 7; k += 1) {
      const wd = (T.weekStart + k) % 7;
      if (rest !== 'none' && wd === +rest) rows.push({ wd, kind: 'rest', cells: [] });
      else rows.push({ wd, kind: 'study', cells: orderDay(fillDay(list, s => s.w, N, credit)) });
    }
    return { rows, notes: [] };
  }

  const plan = exam ? examPlan() : weekPlan();
  const hasRows = plan.rows.length > 0;
  plan.notes.forEach(x => notes.push(x));
  const starved = hasRows ? list.filter(s => !s.out && !s.n) : [];
  if (starved.length) notes.push(T.notes.starved.replace('{names}', names(starved)));

  const sessionTimes = [];
  if (from !== null) {
    for (let k = 0; k < N; k += 1) {
      const at = from + k * (len + BREAK);
      sessionTimes.push(clock(at) + ' – ' + clock(at + len));
    }
  }
  return {
    mode: exam ? 'until_last_exam' : 'one_week',
    title: T.sheetTitle[exam ? 'exam' : 'week'],
    sessions_per_day: N,
    session_minutes: len,
    session_times: sessionTimes,
    days: plan.rows.map(row => ({
      date: row.d === undefined ? null : isoOf(row.d),
      weekday: T.days[row.d === undefined ? row.wd : weekday(row.d)],
      kind: row.kind, // study | review | rest | none
      exams: (row.exams || []).map(s => s.name),
      sessions: row.cells.map(s => s.name),
    })),
    summary: hasRows ? list.filter(s => !s.out).map(s => ({ subject: s.name, sessions: s.n, hours: r(1, s.n * len / 60) })) : [],
    notes,
  };
}

// ===================================================================================
// 7. bmi-calculator
// ===================================================================================
const LB = 0.45359237;
const IN = 2.54;
function body(i, T) {
  const imperial = en(i, 'units', ['metric', 'imperial'], 'metric') === 'imperial';
  const age = num(i, 'age');
  const cm = imperial ? (num(i, 'height_ft') * 12 + num(i, 'height_in')) * IN : num(i, 'height_cm');
  const kg = imperial ? num(i, 'weight_lb') * LB : num(i, 'weight_kg');
  if (!age || !cm || !kg) {
    throw new Error((imperial ? 'age, height_ft/height_in and weight_lb' : 'age, height_cm and weight_kg') + ' are required: ' + T.notes.missing);
  }
  return { imperial, age, cm, kg };
}
function bmi(i) {
  only(i, ['units', 'age', 'height_cm', 'weight_kg', 'height_ft', 'height_in', 'weight_lb']);
  const T = TX('bmi-calculator');
  const { imperial, age, cm, kg } = body(i, T);
  if (age < 18) throw new Error('age: ' + T.notes.minor);
  if (cm < 120 || cm > 230 || kg < 30 || kg > 300) throw new Error('height/weight: ' + T.notes.range);
  const category = b => (b < 18.5 ? 0 : b < 25 ? 1 : b < 30 ? 2 : b < 35 ? 3 : b < 40 ? 4 : 5);
  const wt = v => (imperial ? v / LB : v);
  const weightText = v => fm(1, wt(v)) + ' ' + (imperial ? T.lbs : T.kg);

  const m2 = Math.pow(cm / 100, 2);
  const b = Math.round(kg / m2 * 10) / 10;
  const low = 18.5 * m2;
  const high = 24.9 * m2;
  const gap = b < 18.5 ? T.gap.low.replace('{x}', weightText(low - kg))
    : b >= 25 ? T.gap.high.replace('{x}', weightText(kg - high))
      : T.gap.ok;
  return {
    bmi: b,
    unit: T.unit,
    category: T.cats[category(b)],
    healthy_weight_range: { min: r(1, wt(low)), max: r(1, wt(high)), unit: imperial ? 'lb' : 'kg' },
    gap_from_healthy_range: b < 18.5 ? r(1, wt(low - kg)) : b >= 25 ? r(1, wt(kg - high)) : 0,
    gap_message: gap,
    notes: b >= 23 ? [T.notes.ethnic] : [],
  };
}

// ===================================================================================
// 8. calorie-calculator
// ===================================================================================
function calorie(i) {
  only(i, ['units', 'sex', 'age', 'height_cm', 'weight_kg', 'height_ft', 'height_in', 'weight_lb', 'activity', 'goal']);
  const T = TX('calorie-calculator');
  const FLOOR = 1200, CUT = 500, ADD = 250;
  const { age, cm, kg } = body(i, T);
  if (age < 18 || age > 80) throw new Error('age: ' + T.notes.age);
  if (cm < 120 || cm > 230 || kg < 30 || kg > 300) throw new Error('height/weight: ' + T.notes.range);
  const sex = en(i, 'sex', ['m', 'f'], 'm');
  const act = en(i, 'activity', T.act, '1.55');
  const goal = en(i, 'goal', ['keep', 'lose', 'gain'], 'keep');

  const bmr = 10 * kg + 6.25 * cm - 5 * age + (sex === 'm' ? 5 : -161);
  const tdee = bmr * parseFloat(act);
  const bmiV = kg / Math.pow(cm / 100, 2);
  let target = tdee;
  const notes = [];
  const floor = String(fm(0, FLOOR));
  if (goal === 'lose') {
    if (bmiV < 18.5) {
      notes.push(T.notes.thin);
    } else if (tdee - CUT >= FLOOR) {
      target = tdee - CUT;
    } else if (tdee > FLOOR) {
      target = FLOOR;
      notes.push(T.notes.floor.replace('{floor}', floor));
    } else {
      notes.push(T.notes.floorKeep.replace('{floor}', floor));
    }
  } else if (goal === 'gain') {
    target = tdee + ADD;
  }
  const t = Math.round(target);
  return {
    unit: 'kcal per day',
    suggested_calories: r(0, t),
    bmr: r(0, bmr),
    maintenance_calories: r(0, tdee),
    difference_from_maintenance: t - Math.round(tdee),
    notes,
  };
}

// ===================================================================================
// 9. due-date-calculator
// ===================================================================================
function dueDate(i) {
  only(i, ['method', 'date', 'cycle_length', 'as_of_date', 'today']);
  const T = TX('due-date-calculator');
  const method = en(i, 'method', ['lmp', 'conception'], 'lmp');
  const byLmp = method === 'lmp';
  const unit = (n, what) => {
    if (n === 0 || n === 1) return what === 'week' ? 'أسبوع' : 'يوم';
    if (n === 2) return what === 'week' ? 'أسبوعان' : 'يومان';
    if (n <= 10) return what === 'week' ? 'أسابيع' : 'أيام';
    return what === 'week' ? 'أسبوعًا' : 'يومًا';
  };
  const weeksDays = g => {
    const w = Math.floor(g / 7);
    const d = g % 7;
    return T.wordWeeks.replace('{w}', String(w)).replace('{d}', String(d)).replace('{wu}', unit(w, 'week')).replace('{du}', unit(d, 'day'));
  };

  const d = dayNum(i.date, 'date', true);
  const notes = [];
  if (d === null) throw new Error('date: ' + T.notes.date);
  let cycle = 28;
  if (byLmp) {
    cycle = has(i.cycle_length) ? Math.round(num(i, 'cycle_length')) : 28;
    if (cycle < 21 || cycle > 45) throw new Error('cycle_length: ' + T.notes.cycle);
    if (cycle > 35) notes.push(T.notes.cycleOdd);
  }
  // Day 0 of the count is the first day of a 28-day-cycle period
  const start = byLmp ? d + (cycle - 28) : d - 14;
  const today = todayNum(i);
  let asof = dayNum(i.as_of_date, 'as_of_date', true);
  const custom = asof !== null;
  if (!custom) asof = today;
  if (asof < d) throw new Error(custom ? 'as_of_date: ' + T.notes.asof : 'date: ' + T.notes.future);
  const edd = start + 280;
  const gAdj = Math.max(0, asof - start);
  if (asof - start > 294) throw new Error('date: ' + T.notes.old);
  if (gAdj > 280) notes.push(T.notes.past);

  const tri = gAdj < 98 ? 0 : gAdj < 196 ? 1 : 2;
  const left = edd - asof;
  return {
    due_date: isoOf(edd),
    gestational_age: { weeks: Math.floor(gAdj / 7), days: gAdj % 7, text: weeksDays(gAdj) },
    trimester: T.triNames[tri],
    days_left: left >= 0 ? left : null,
    first_day_of_count: isoOf(start),
    milestones: T.ms.map(m => ({ name: m[0], gestational_age: m[1], date: isoOf(start + m[2]) })),
    notes,
  };
}

// ===================================================================================
// 10. ovulation-calculator
// ===================================================================================
function ovulation(i) {
  only(i, ['last_period_date', 'cycle_length', 'luteal_phase', 'today']);
  const T = TX('ovulation-calculator');
  const lmp = dayNum(i.last_period_date, 'last_period_date', true);
  if (lmp === null) throw new Error('last_period_date: ' + T.notes.date);
  const cycle = has(i.cycle_length) ? Math.round(num(i, 'cycle_length')) : 28;
  if (cycle < 21 || cycle > 40) throw new Error('cycle_length: ' + T.notes.cycle);
  const luteal = has(i.luteal_phase) ? Math.round(num(i, 'luteal_phase')) : 14;
  if (luteal < 10 || luteal > 16) throw new Error('luteal_phase: ' + T.notes.luteal);
  const today = todayNum(i);
  if (lmp > today) throw new Error('last_period_date: ' + T.notes.future);
  if (today - lmp > 365) throw new Error('last_period_date: ' + T.notes.old);

  const notes = [];
  const k = Math.floor((today - lmp) / cycle);
  if (k > 0) notes.push(T.notes.rolled);
  notes.push(T.notes.irregular);
  const start = lmp + k * cycle;
  const ov = start + cycle - luteal;
  const next = [];
  for (let n = 1; n <= 3; n += 1) {
    const s = start + n * cycle;
    const o = s + cycle - luteal;
    next.push({ period_start: isoOf(s), ovulation_date: isoOf(o), fertile_from: isoOf(o - 5), fertile_to: isoOf(o) });
  }
  return {
    ovulation_date: isoOf(ov),
    fertile_window: { from: isoOf(ov - 5), to: isoOf(ov) },
    next_period: isoOf(start + cycle),
    current_cycle_start: isoOf(start),
    cycle_length: cycle,
    luteal_phase: luteal,
    next_cycles: next,
    notes,
  };
}

// ===================================================================================
// 11. pharmacy-margin-calculator
// ===================================================================================
function pharmacy(i) {
  only(i, ['mode', 'target_margin_pct', 'discount_pct', 'currency', 'items']);
  const T = TX('pharmacy-margin-calculator');
  const currency = en(i, 'currency', CUR_AED, 'EGP');
  const target = en(i, 'mode', ['price', 'target'], 'price') === 'target';
  const tm = num(i, 'target_margin_pct');
  const tmOk = tm > 0 && tm < 100;
  const rows = arr(i, 'items', T.rows, true);
  const notes = [];
  const tmNote = target && has(i.target_margin_pct) && !tmOk;
  if (tmNote) notes.push(T.notes.tm);

  const lines = [];
  let qtyGiven = false;
  let anyLoss = false;
  rows.forEach((row, k) => {
    only(row, ['cost', 'price', 'quantity']);
    const c = num(row, 'cost', `items[${k}].cost`);
    let p = 0;
    if (target) {
      p = c && tmOk ? c / (1 - tm / 100) : 0;
    } else {
      p = num(row, 'price', `items[${k}].price`);
    }
    if (!c || !p) return;
    const hasQty = has(row.quantity);
    if (hasQty) qtyGiven = true;
    const q = hasQty ? num(row, 'quantity', `items[${k}].quantity`) : 1;
    if (!q) return;
    if (p < c) anyLoss = true;
    lines.push({ n: k + 1, c, p, q });
  });
  if (anyLoss) notes.push(T.notes.loss);
  if (!lines.length) {
    throw new Error(tmNote ? 'target_margin_pct: ' + T.notes.tm
      : 'items: at least one item needs a cost' + (target ? '' : ' and a selling price') + ' greater than 0 (and a quantity not equal to 0)');
  }

  let rev = 0, cost = 0, qty = 0;
  lines.forEach(l => { rev += l.p * l.q; cost += l.c * l.q; qty += l.q; });
  const profit = rev - cost;
  const out = {
    currency,
    margin_pct: r(1, (profit / rev) * 100),
    markup_pct: r(1, (profit / cost) * 100),
    revenue: r(2, rev),
    cost: r(2, cost),
    profit: r(2, profit),
    unit_profit: lines.length === 1 ? r(2, lines[0].p - lines[0].c) : null,
    items: lines.map(l => {
      const u = l.p - l.c;
      return { n: l.n, price: r(2, l.p), unit_profit: r(2, u), markup_pct: r(1, (u / l.c) * 100), margin_pct: r(1, (u / l.p) * 100) };
    }),
    discount: null,
  };
  const d = num(i, 'discount_pct');
  if (d >= 100) notes.push(T.notes.discHigh);
  if (d > 0 && d < 100) {
    const rev2 = rev * (1 - d / 100);
    const profit2 = rev2 - cost;
    const can = profit > 0 && profit2 > 0;
    if (profit <= 0) notes.push(T.notes.noProfit);
    else if (profit2 <= 0) notes.push(T.notes.noRecover);
    const disc = { revenue: r(2, rev2), profit: r(2, profit2), margin_pct: r(1, (profit2 / rev2) * 100), extra_volume_needed_pct: null, units_needed: null, units_now: null };
    if (can) {
      const ratio = profit / profit2;
      disc.extra_volume_needed_pct = r(1, (ratio - 1) * 100);
      if (qtyGiven) { disc.units_needed = r(0, Math.ceil(qty * ratio - 1e-9)); disc.units_now = r(0, qty); }
    }
    out.discount = disc;
  }
  out.notes = notes;
  return out;
}

// ===================================================================================
// 12. reorder-point-calculator
// ===================================================================================
function reorderPoint(i) {
  only(i, ['method', 'daily_sales', 'lead_time_days', 'order_cycle_days', 'cover_days', 'daily_sales_sd', 'service_level_pct', 'shelf_life_days']);
  const T = TX('reorder-point-calculator');
  // Round up, but not because of floating point noise (3 x 20 = 60.00000000000001)
  const up = v => Math.ceil(v - 1e-9);
  const method = en(i, 'method', ['days', 'service'], 'days');
  const sl = en(i, 'service_level_pct', Object.keys(T.z), '95');
  const d = num(i, 'daily_sales');
  const L = num(i, 'lead_time_days');
  const R = num(i, 'order_cycle_days');
  const shelf = num(i, 'shelf_life_days');
  if (!(d > 0 && L > 0)) throw new Error('daily_sales and lead_time_days are required (each greater than 0)');
  const notes = [];

  const z = T.z[sl];
  let ssRaw;
  if (method === 'days') {
    ssRaw = d * num(i, 'cover_days');
    if (!has(i.cover_days)) notes.push(T.notes.cover);
  } else {
    ssRaw = z * num(i, 'daily_sales_sd') * Math.sqrt(L);
    if (!has(i.daily_sales_sd)) notes.push(T.notes.sd);
  }
  const dlt = d * L;
  const rop = up(dlt + ssRaw);
  const ss = up(ssRaw);
  const qty = R > 0 ? up(d * R) : 0;
  const peak = ss + qty;

  if (shelf > 0) {
    const vars = { ss: fm(0, ss), peak: fm(0, peak), shelf: fm(1, shelf), days: '', max: '' };
    if (qty > 0 && peak / d > shelf) {
      vars.days = fm(1, peak / d);
      const max = Math.floor(d * shelf - ss);
      if (max > 0) {
        vars.max = fm(0, max);
        notes.push(fill(T.notes.shelfQty, vars));
      } else {
        notes.push(fill(T.notes.shelfSs, { ss: vars.ss, days: fm(1, ss / d), shelf: vars.shelf }));
      }
    } else if (qty === 0 && ss / d > shelf) {
      notes.push(fill(T.notes.shelfSs, { ss: vars.ss, days: fm(1, ss / d), shelf: vars.shelf }));
    }
  }
  const assumptions = [T.assume.base, T.assume.order];
  assumptions.push(method === 'days' ? T.assume.days : fill(T.assume.service, { z, sl }));
  if (qty > 0) assumptions.push(T.assume.qty);
  assumptions.push(T.assume.round);

  return {
    unit: 'units',
    reorder_point: r(0, rop),
    demand_during_lead_time: r(1, dlt),
    safety_stock: r(0, ss),
    suggested_order_quantity: qty > 0 ? r(0, qty) : null,
    peak_stock_after_delivery: qty > 0 ? r(0, peak) : null,
    peak_stock_days_of_sales: qty > 0 ? r(1, peak / d) : null,
    assumptions,
    notes,
  };
}

// ===================================================================================
// 13. no-show-cost-calculator
// ===================================================================================
function noShow(i) {
  only(i, ['entry', 'booked_per_month', 'no_shows_per_month', 'no_show_pct', 'fee_per_visit', 'providers', 'reduction_pct', 'system_cost_per_month', 'currency']);
  const T = TX('no-show-cost-calculator');
  const currency = en(i, 'currency', CUR_AED, 'EGP');
  const byPct = en(i, 'entry', ['count', 'percent'], 'count') === 'percent';
  const booked = num(i, 'booked_per_month');
  const fee = num(i, 'fee_per_visit');
  const docs = num(i, 'providers');
  const red = num(i, 'reduction_pct');
  const cost = num(i, 'system_cost_per_month');
  const notes = [];

  let ns = 0;
  let why = '';
  if (byPct) {
    const pct = num(i, 'no_show_pct');
    if (pct >= 100) { notes.push(T.notes.pct); why = 'no_show_pct: ' + T.notes.pct; } else ns = (booked * pct) / 100;
  } else {
    ns = num(i, 'no_shows_per_month');
    if (ns > booked && booked > 0) { notes.push(T.notes.over); why = 'no_shows_per_month: ' + T.notes.over; }
  }
  const ok = booked > 0 && ns > 0 && ns <= booked;
  if (!ok) throw new Error(why || (byPct ? 'booked_per_month and no_show_pct are required (each greater than 0)' : 'booked_per_month and no_shows_per_month are required (each greater than 0)'));
  if (red > 100) notes.push(T.notes.redHigh);

  const rate = (ns / booked) * 100;
  const lostM = ns * fee;
  const haveFee = fee > 0;
  const out = {
    currency,
    no_show_rate_pct: r(1, rate),
    no_show_visits_per_month: r(1, ns),
    lost_revenue_per_month: haveFee ? r(2, lostM) : null,
    lost_revenue_per_year: haveFee ? r(2, lostM * 12) : null,
    lost_revenue_per_provider_per_month: haveFee && docs > 0 ? r(2, lostM / docs) : null,
    scenario: null,
  };
  if (red > 0 && red <= 100) {
    const f = red / 100;
    const rec = lostM * f;
    const sc = {
      reduction_pct: r(1, red),
      new_no_show_rate_pct: r(1, rate * (1 - f)),
      recovered_visits_per_month: r(1, ns * f),
      recovered_revenue_per_month: haveFee ? r(2, rec) : null,
      recovered_revenue_per_year: haveFee ? r(2, rec * 12) : null,
      break_even_system_cost_per_month: haveFee ? r(2, rec) : null,
      net_per_month: null,
      break_even_reduction_pct: null,
      break_even_visits: null,
    };
    if (haveFee && cost > 0) {
      sc.net_per_month = r(2, rec - cost);
      sc.break_even_reduction_pct = r(1, (cost / lostM) * 100);
      sc.break_even_visits = r(1, cost / fee);
      if (rec < cost) notes.push(T.notes.neg);
    }
    out.scenario = sc;
  }
  out.notes = notes;
  return out;
}

// ===================================================================================
// registry
// ===================================================================================
const CURRENCY_DESC = 'Currency code, a label only (does not change any number).';
const N = (description, extra) => Object.assign({ type: 'number', description }, extra || {});
const E = (type, description, values, def) => ({ type, description, enum: values, default: def });

const IMPL = {
  'garment-cost': garmentCost,
  'fabric-consumption': fabricConsumption,
  'break-even': breakEven,
  'piece-rate': pieceRate,
  'vat-calculator': vat,
  'study-schedule': studySchedule,
  'bmi-calculator': bmi,
  'calorie-calculator': calorie,
  'due-date-calculator': dueDate,
  'ovulation-calculator': ovulation,
  'pharmacy-margin-calculator': pharmacy,
  'reorder-point-calculator': reorderPoint,
  'no-show-cost-calculator': noShow,
};

const META = [
  {
    id: 'garment-cost',
    description: 'Computes the cost of one garment from fabric, trims, labour, overheads and rejects, the selling price for a target margin, and the cost of an order; use it to price a style before production.',
    inputs: {
      consumption: N('Fabric consumption per piece, in the purchase unit (metres or kg).'),
      unit: E('string', 'Unit the fabric is bought in.', ['m', 'kg'], 'm'),
      fabric_price: N('Fabric price per unit (per metre or kg).'),
      cutting_waste_pct: N('Cutting waste as a percentage of consumption.'),
      trims: N('Trims per piece (buttons, zips, thread, labels).'),
      packaging: N('Packaging per piece.'),
      outside_work: N('Outside printing, embroidery or washing per piece.'),
      labor_mode: E('string', 'Give labour per piece directly, or work it out from monthly wages and monthly output.', ['piece', 'wages'], 'piece'),
      labor_per_piece: N('Labour cost per piece (used when labor_mode is "piece").'),
      monthly_wages: N('Total monthly wages of production staff (used when labor_mode is "wages"; needs monthly_output).'),
      monthly_overhead: N('Monthly overheads (rent, power, maintenance, admin); needs monthly_output.'),
      monthly_output: N('Monthly output in pieces; monthly wages and overheads are divided by it.'),
      reject_pct: N('Reject rate in percent; above 90 is capped at 90.'),
      target_margin_pct: N('Target margin on the selling price, in percent (below 100).'),
      selling_price: N('Actual selling price per piece (optional).'),
      order_quantity: N('Order quantity in pieces (optional).'),
      currency: E('string', CURRENCY_DESC, CUR4, 'EGP'),
    },
    output: 'cost_per_piece with a breakdown (amount and share by fabric, trims, outside work, labour, overhead, reject allowance); suggested price, profit at the actual price and whole-order figures when the inputs for them are given; notes.',
  },
  {
    id: 'fabric-consumption',
    description: 'Computes the fabric one piece uses (metres and kg) from the marker length, pieces per marker, end loss, width and GSM, and the fabric an order needs; use it for marker-based fabric estimates.',
    inputs: {
      marker_length_m: N('Marker length in metres.'),
      pieces_per_marker: N('Pieces that fit in one marker.'),
      end_loss_cm: N('End loss per ply in cm (what is left at the start and end of each ply when spreading).'),
      fabric_width_cm: N('Usable fabric width in cm (needed for kg figures).'),
      gsm: N('Fabric weight in grams per square metre (needed for kg figures).'),
      extra_allowance_pct: N('Extra allowance in percent (joins, fabric defects, roll ends).'),
      order_quantity: N('Order quantity in pieces (optional).'),
      reject_pct: N('Expected reject rate in percent for the order; above 90 is capped at 90.'),
      unit: E('string', 'Unit of the headline consumption figure.', ['m', 'kg'], 'm'),
    },
    output: 'consumption_per_piece in the chosen unit, meters_per_piece, kg_per_piece, kg_per_meter, meters_per_kg, and an order block (pieces to cut, plies, total metres and kg) when order_quantity is given; notes.',
  },
  {
    id: 'break-even',
    description: 'Computes the units and sales needed to cover fixed costs, per-day targets, units for a target profit and the profit and safety margin at a planned volume; use it to find a factory or shop break-even point.',
    inputs: {
      rent: N('Monthly rent.'),
      salaries: N('Monthly fixed salaries.'),
      utilities: N('Monthly utilities.'),
      installments: N('Monthly instalments.'),
      other_fixed: N('Other monthly fixed costs.'),
      price_per_unit: N('Selling price per unit (required).', { required: true }),
      variable_cost_per_unit: N('Variable cost per unit.'),
      target_profit: N('Monthly profit you want (optional).'),
      planned_units: N('Planned monthly sales volume in units (optional).'),
      working_days: N('Working days in the month, for per-day figures (optional).'),
      currency: E('string', CURRENCY_DESC, CUR4, 'EGP'),
    },
    output: 'break_even_units, fixed_costs, contribution_per_unit, contribution_ratio_pct, break_even_sales, per-day units, plus target_profit and planned blocks when given; null fields where the page shows a dash; notes.',
  },
  {
    id: 'piece-rate',
    description: 'Computes a worker or line output per day and hour at a given efficiency, a piece rate from a monthly wage, and actual efficiency and earnings; use it to set and check piece-rate pay.',
    inputs: {
      standard_minutes_per_piece: N('Standard time per piece or operation in minutes (SAM).', { required: true }),
      hours_per_day: N('Actual working hours per day.', { required: true }),
      workers: N('Number of workers (default 1); above 1 adds a group figure.'),
      efficiency_pct: N('Expected efficiency in percent (blank means 100).'),
      monthly_wage: N('Target monthly wage per worker, to derive a rate per piece (needs working_days).'),
      working_days: N('Working days per month.'),
      actual_pieces_per_day: N('Pieces the worker actually made in a day, to get actual efficiency and earnings (optional).'),
      currency: E('string', CURRENCY_DESC, CUR4, 'EGP'),
    },
    output: 'pieces_per_day, pieces_per_hour, pieces_per_day_at_full_efficiency, group_pieces_per_day, daily_wage, rate_per_piece, actual efficiency and earnings; notes.',
  },
  {
    id: 'vat-calculator',
    description: 'Adds VAT to net prices or extracts the VAT included in gross prices for Egypt (14%), Saudi Arabia (15%), UAE (5%) or a custom rate, line by line with invoice-style rounding; use it for invoices.',
    inputs: {
      country: E('string', 'Country whose standard rate applies, or "other" with rate_pct.', ['eg', 'sa', 'ae', 'other'], 'eg'),
      rate_pct: N('VAT rate in percent (required when country is "other").'),
      mode: E('string', '"add" treats prices as before tax; "extract" treats them as including tax.', ['add', 'extract'], 'add'),
      currency: E('string', 'Currency code, a label only. Default follows the country.', CUR_AED, undefined),
      lines: { type: 'array', required: true, description: 'Up to 10 lines, each {price: number, quantity?: number (default 1)}. Lines without a price are ignored.' },
    },
    output: 'net, tax, gross totals, the headline amount for the mode, rate_pct and a per-line net/tax/gross list when there is more than one line; notes.',
  },
  {
    id: 'study-schedule',
    description: 'Builds a study timetable that shares daily sessions between subjects by difficulty and exam proximity (with a final-review day and optional rest day), or a one-week plan without exam dates; use it to plan revision.',
    inputs: {
      subjects: { type: 'array', required: true, description: 'Up to 12 subjects, each {name: string (max 40 chars), exam_date?: YYYY-MM-DD, difficulty?: "1" easy | "2" medium (default) | "3" hard}.' },
      sessions_per_day: { type: 'integer', required: true, description: 'Study sessions per day (capped at 12).' },
      session_minutes: E('integer', 'Length of a session in minutes.', [45, 60, 90, 120], 60),
      rest_day: E('string', 'Weekday of rest: "none" or 0 (Sunday) to 6 (Saturday).', ['none', '0', '1', '2', '3', '4', '5', '6'], 'none'),
      start_date: { type: 'date', description: 'First day of the plan, YYYY-MM-DD (default today).' },
      first_session_time: { type: 'string', description: 'Start time of the first session as HH:MM (24h), to get session time slots (optional).' },
      today: { type: 'date', description: 'Override for today, YYYY-MM-DD (used when start_date is omitted; default: the real date).' },
    },
    output: 'mode, title, per-day rows (date, weekday, kind study/review/rest/none, exams, ordered sessions), per-subject sessions and hours, optional session time slots; notes.',
  },
  {
    id: 'bmi-calculator',
    description: 'Computes body mass index for adults (18+), its category and the healthy weight range for the given height, in metric or imperial units; use it for a general screening figure, not a diagnosis.',
    inputs: {
      units: E('string', 'Unit system for the inputs.', ['metric', 'imperial'], 'metric'),
      age: N('Age in years (18 or more).', { required: true }),
      height_cm: N('Height in cm (metric; 120 to 230).'),
      weight_kg: N('Weight in kg (metric; 30 to 300).'),
      height_ft: N('Height, feet part (imperial).'),
      height_in: N('Height, inches part (imperial).'),
      weight_lb: N('Weight in pounds (imperial).'),
    },
    output: 'bmi, unit, category (page wording), healthy_weight_range {min, max, unit}, gap_from_healthy_range and gap_message, notes (page wording).',
  },
  {
    id: 'calorie-calculator',
    description: 'Estimates daily calories: basal metabolic rate (Mifflin-St Jeor), maintenance calories by activity level, and a suggested intake to keep, lose or gain weight; use it as a general estimate, not medical advice.',
    inputs: {
      units: E('string', 'Unit system for the inputs.', ['metric', 'imperial'], 'metric'),
      sex: E('string', 'Sex used by the formula.', ['m', 'f'], 'm'),
      age: N('Age in years (18 to 80).', { required: true }),
      height_cm: N('Height in cm (metric; 120 to 230).'),
      weight_kg: N('Weight in kg (metric; 30 to 300).'),
      height_ft: N('Height, feet part (imperial).'),
      height_in: N('Height, inches part (imperial).'),
      weight_lb: N('Weight in pounds (imperial).'),
      activity: E('string', 'Activity factor: 1.2 sedentary, 1.375 light, 1.55 moderate, 1.725 high, 1.9 very high.', ['1.2', '1.375', '1.55', '1.725', '1.9'], '1.55'),
      goal: E('string', 'Goal.', ['keep', 'lose', 'gain'], 'keep'),
    },
    output: 'suggested_calories, bmr, maintenance_calories, difference_from_maintenance (kcal per day) and notes (page wording).',
  },
  {
    id: 'due-date-calculator',
    description: 'Estimates the expected delivery date and gestational age from the first day of the last period (with cycle length) or from a conception date, with trimester and milestone dates; an estimate to discuss with a doctor.',
    inputs: {
      method: E('string', 'Start from the last period ("lmp") or from the conception date ("conception").', ['lmp', 'conception'], 'lmp'),
      date: { type: 'date', required: true, description: 'First day of the last period, or the conception date, YYYY-MM-DD.' },
      cycle_length: { type: 'integer', description: 'Cycle length in days, 21 to 45 (only with method "lmp"; default 28).' },
      as_of_date: { type: 'date', description: 'Calculate gestational age on this date instead of today, YYYY-MM-DD (optional).' },
      today: { type: 'date', description: 'Override for today, YYYY-MM-DD (default: the real date).' },
    },
    output: 'due_date, gestational_age {weeks, days, text}, trimester, days_left, first_day_of_count, milestones [{name, gestational_age, date}], notes (page wording).',
  },
  {
    id: 'ovulation-calculator',
    description: 'Estimates the ovulation day, the five-day fertile window and the next period from the last period start, cycle length and luteal phase, plus the next three cycles; an estimate, less reliable for irregular cycles.',
    inputs: {
      last_period_date: { type: 'date', required: true, description: 'First day of the last period, YYYY-MM-DD.' },
      cycle_length: { type: 'integer', description: 'Cycle length in days, 21 to 40 (default 28).' },
      luteal_phase: { type: 'integer', description: 'Luteal phase in days, 10 to 16 (default 14).' },
      today: { type: 'date', description: 'Override for today, YYYY-MM-DD (default: the real date).' },
    },
    output: 'ovulation_date, fertile_window {from, to}, next_period, current_cycle_start, next_cycles (3), notes (page wording).',
  },
  {
    id: 'pharmacy-margin-calculator',
    description: 'Computes profit margin and markup for pharmacy items from cost and selling price (or from a target margin), and what a discount costs you and how much extra volume recovers it; use it for pricing and discount decisions.',
    inputs: {
      mode: E('string', '"price" = you give selling prices; "target" = prices are derived from target_margin_pct.', ['price', 'target'], 'price'),
      target_margin_pct: N('Target margin in percent, above 0 and below 100 (mode "target").'),
      discount_pct: N('Discount to test, in percent, below 100 (optional).'),
      currency: E('string', CURRENCY_DESC, CUR_AED, 'EGP'),
      items: { type: 'array', required: true, description: 'Up to 8 items, each {cost: number, price?: number (mode "price"), quantity?: number (default 1)}.' },
    },
    output: 'margin_pct, markup_pct, revenue, cost, profit, unit_profit, per-item figures, and a discount block (revenue, profit, margin, extra volume needed) when discount_pct is given; notes.',
  },
  {
    id: 'reorder-point-calculator',
    description: 'Computes a pharmacy reorder point and safety stock from daily sales and lead time (by days of cover or service level), a suggested order quantity and the peak stock, with shelf-life warnings; use it to decide when to reorder.',
    inputs: {
      method: E('string', 'Safety stock by days of cover ("days") or by service level ("service").', ['days', 'service'], 'days'),
      daily_sales: N('Average daily sales in units.', { required: true }),
      lead_time_days: N('Days from order to delivery.', { required: true }),
      order_cycle_days: N('Days between orders, to get a suggested order quantity (optional).'),
      cover_days: N('Extra days of cover (method "days").'),
      daily_sales_sd: N('Standard deviation of daily sales (method "service").'),
      service_level_pct: E('string', 'Service level in percent (method "service").', ['90', '95', '97.5', '99'], '95'),
      shelf_life_days: N('Remaining shelf life on arrival, in days (optional, for warnings).'),
    },
    output: 'reorder_point, demand_during_lead_time, safety_stock, suggested_order_quantity, peak_stock_after_delivery, peak_stock_days_of_sales, assumptions and notes.',
  },
  {
    id: 'no-show-cost-calculator',
    description: 'Computes the monthly and yearly revenue a clinic loses to patient no-shows and what a reduction scenario would recover against a reminder system cost; use it to judge appointment-reminder tools.',
    inputs: {
      entry: E('string', 'Give the no-shows as a count or as a percentage of booked appointments.', ['count', 'percent'], 'count'),
      booked_per_month: N('Appointments booked per month.', { required: true }),
      no_shows_per_month: N('Patients who did not come and did not cancel per month (entry "count").'),
      no_show_pct: N('No-show rate in percent, below 100 (entry "percent").'),
      fee_per_visit: N('Average fee per visit.'),
      providers: N('Number of doctors or chairs, for a per-provider figure (optional).'),
      reduction_pct: N('Expected reduction in no-shows, in percent, up to 100 (optional).'),
      system_cost_per_month: N('Monthly cost of the reminder system (optional).'),
      currency: E('string', CURRENCY_DESC, CUR_AED, 'EGP'),
    },
    output: 'no_show_rate_pct, no_show_visits_per_month, lost revenue per month/year/provider, and a scenario block (new rate, recovered visits and revenue, net after system cost, break-even) when reduction_pct is given; notes.',
  },
];

// drop `default: undefined` keys
META.forEach(m => Object.keys(m.inputs).forEach(k => { if (m.inputs[k].default === undefined) delete m.inputs[k].default; }));

const list = META.map(m => ({
  id: m.id,
  title: TEXT[m.id].title,
  description: m.description,
  inputs: m.inputs,
  output: m.output,
}));

function run(id, inputs) {
  const fn = IMPL[id];
  if (!fn) throw new Error(`Unknown tool "${id}"`);
  if (inputs === undefined || inputs === null) inputs = {};
  if (typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('inputs must be an object');
  return fn(inputs);
}

module.exports = { list, run };
