'use strict';
// Qintar gold calculators exposed as tools: { list, run }.
// Proxied (single source of truth = qintar.app API): gold-zakat, gold-nisab, gold-making-charge, gold-bullion-prices.
// Local (formulas of docs/14-GOLD-CALCULATORS.md and the qintar.app/tools pages): the other six.
// Live prices are fetched from the public API (60 s cache, 5 s timeout). No fallback prices, ever.

const API = 'https://qintar.app/api/v1/';
const SOURCE = 'qintar.app';
const TTL_MS = 60 * 1000;
const TIMEOUT_MS = 5000;
const DISCLAIMER = 'الحسابات استرشادية ولا تُعدّ نصيحة مالية أو فتوى.';

const PURITY = { K24: 0.999, K21: 0.875, K18: 0.75 };
const KARATS = ['K24', 'K21', 'K18'];
const KINDS = ['BAR', 'COIN', 'SIMPLE_JEWELRY', 'MEDIUM_JEWELRY', 'COMPLEX_JEWELRY'];
const KINDS_BY_KARAT = {
  K24: ['BAR', 'COIN'],
  K21: ['SIMPLE_JEWELRY', 'MEDIUM_JEWELRY', 'COMPLEX_JEWELRY'],
  K18: ['SIMPLE_JEWELRY', 'MEDIUM_JEWELRY', 'COMPLEX_JEWELRY'],
};
const UNIT_GRAMS = { gram: 1, kilogram: 1000, ounce: 31.1034768, tola: 11.6638038, pound: 8, halfPound: 4, quarterPound: 2 };
const POUND_UNITS = ['pound', 'halfPound', 'quarterPound'];
const SCHOOLS = ['HANAFI', 'MALIKI', 'SHAFII', 'HANBALI'];

// ---------- helpers ----------
const round = (v, d = 2) => {
  const m = Math.pow(10, d);
  const x = Math.round((v + Number.EPSILON * Math.sign(v)) * m) / m;
  return x === 0 ? 0 : x;
};
const r2 = (v) => round(v, 2);
const fmt = (v, d = 2) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function numIn(inputs, name, { min, max, gt, required = false, def } = {}) {
  let v = inputs[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${name} is required`);
    return def;
  }
  if (typeof v === 'string' && v.trim() !== '' && /^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim())) v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  if (gt !== undefined && !(v > gt)) throw new Error(`${name} must be greater than ${gt}`);
  if (min !== undefined && v < min) throw new Error(`${name} must be at least ${min}`);
  if (max !== undefined && v > max) throw new Error(`${name} must be at most ${max}`);
  return v;
}
function enumIn(inputs, name, allowed, { required = false, def } = {}) {
  const v = inputs[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${name} is required (one of ${allowed.join(', ')})`);
    return def;
  }
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return v;
}
function checkInputs(inputs) {
  if (inputs === undefined || inputs === null) return {};
  if (!isObj(inputs)) throw new Error('inputs must be an object');
  return inputs;
}

// ---------- HTTP ----------
async function fetchJson(path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API + path, { ...(init || {}), signal: ctl.signal, headers: { accept: 'application/json', ...((init && init.headers) || {}) } });
  } catch (e) {
    throw new Error(`Could not reach qintar.app (${e && e.name === 'AbortError' ? 'timeout after 5s' : e.message})`);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* handled below */ }
  if (!res.ok || !body || body.success === false) {
    const err = body && body.error;
    const details = err && Array.isArray(err.details) ? err.details.map((d) => (d.field ? `${d.field}: ` : '') + d.message).join('; ') : '';
    const msg = (err && (details || err.message)) || `HTTP ${res.status}`;
    const e = new Error(`qintar.app API error: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return body.data;
}

let cache = null; // { at: ms, live }
async function getLive() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.live;
  let p, c;
  try {
    [p, c] = await Promise.all([fetchJson('prices/current'), fetchJson('calculators/craftsmanship/ranges')]);
  } catch (e) {
    throw new Error(`Live gold prices could not be fetched from qintar.app, so the calculation was not done (${e.message})`);
  }
  const g = p && p.gold;
  if (!g || !g.K24 || !g.K21 || !g.K18 || !g.K21.sell || !g.K24.sell || !g.K18.sell || !g.K21.buy || !g.K24.buy || !g.K18.buy ||
      !c || !Array.isArray(c.ranges) || !Array.isArray(c.barCharges) || !c.barCharges.length) {
    throw new Error('Live gold prices from qintar.app came back incomplete, so the calculation was not done');
  }
  const live = {
    prices: { K24: g.K24, K21: g.K21, K18: g.K18 },
    ranges: c.ranges,
    bars: c.barCharges,
    vat: c.vatRate || 0.14,
    at: p.lastUpdated || null,
  };
  cache = { at: Date.now(), live };
  return live;
}

// ---------- shared pricing logic (from the pages' calc_common.js) ----------
function feeForBar(L, w) {
  const b = L.bars.slice().sort((a, c) => a.grams - c.grams);
  let fee = b[0].fee;
  for (const x of b) if (x.grams <= w) fee = x.fee;
  return fee;
}
function rangeRow(L, kind, karat) {
  const r = L.ranges.find((x) => x.karat === karat && x.itemType === kind);
  return r ? [r.min, r.max] : null;
}
function typical(L, kind, karat, w) {
  if (kind === 'BAR') { const x = feeForBar(L, w); return [x, x]; }
  return rangeRow(L, kind, karat);
}
function kindKarat(L, inputs, { kindDef, karatDef }) {
  const karat = enumIn(inputs, 'karat', KARATS, { def: karatDef });
  const kind = enumIn(inputs, 'kind', KINDS, { def: kindDef });
  if (!KINDS_BY_KARAT[karat].includes(kind) || !rangeRow(L, kind, karat)) {
    throw new Error(`kind ${kind} is not offered in ${karat} (K24: ${KINDS_BY_KARAT.K24.join('/')}; K21 and K18: ${KINDS_BY_KARAT.K21.join('/')})`);
  }
  return { karat, kind };
}
const priceIn = (inputs, name) => numIn(inputs, name, { gt: 0, max: 10000000 });
function stamp(L, obj) {
  return { ...obj, pricesAsOf: L.at, source: SOURCE, disclaimer: DISCLAIMER };
}

// ---------- local calculators ----------
async function fairPrice(inputs) {
  const L = await getLive();
  const { karat, kind } = kindKarat(L, inputs, { kindDef: 'BAR', karatDef: 'K24' });
  const w = numIn(inputs, 'weightGrams', { gt: 0, max: 100000, required: true });
  const paid = numIn(inputs, 'paidEGP', { gt: 0, max: 1e11, required: true });
  const mk = numIn(inputs, 'makingPerGram', { min: 0, max: 5000 });
  const sell = priceIn(inputs, 'sellPrice') ?? L.prices[karat].sell;
  const vat = L.vat;
  const t = mk !== undefined ? [mk, mk] : typical(L, kind, karat, w);
  const gv = w * sell, lo = gv + w * t[0] * (1 + vat), hi = gv + w * t[1] * (1 + vat);
  const over = paid - hi, pct = over / hi * 100, tol = Math.max(300, hi * 0.03);
  let verdict;
  if (paid < gv * 0.98) verdict = 'below_gold';
  else if (paid <= hi) verdict = 'fair';
  else if (over <= tol) verdict = 'slightly_high';
  else if (pct <= 10) verdict = 'high';
  else verdict = 'very_high';
  const messages = {
    below_gold: 'اللي دفعته أقل من قيمة الذهب نفسه بسعر النهارده. اتأكد من العيار والوزن.',
    fair: 'السعر في النطاق المعتاد أو أقل منه. سعر الذهب بيتحرك خلال اليوم، فقارن دايمًا بسعر وقت الشراء.',
    slightly_high: `أعلى من النطاق المعتاد بحوالي ${fmt(over, 0)} ج (${fmt(pct, 1)}%): فرق صغير ممكن يجي من حركة سعر الذهب خلال اليوم أو من مصنعية المحل.`,
    high: `أعلى من النطاق المعتاد بحوالي ${fmt(over, 0)} ج (${fmt(pct, 1)}%). الفرق يستاهل تسأل عنه: راجع الفاتورة والوزن والدمغة وقارن بمحلات تانية.`,
    very_high: `أعلى بوضوح من النطاق المعتاد: حوالي ${fmt(over, 0)} ج (${fmt(pct, 1)}%). مش معناها بالضرورة إن في خطأ، لكن الفرق كبير؛ راجع الفاتورة وقارن قبل ما تحكم.`,
  };
  return stamp(L, {
    karat, kind, weightGrams: w, paidEGP: paid, sellPriceUsed: sell,
    makingPerGramUsed: { min: t[0], max: t[1], userSupplied: mk !== undefined },
    vatRate: vat,
    goldValueEGP: r2(gv),
    makingPerGramWithVat: { min: r2(t[0] * vat), max: r2(t[1] * vat) },
    fairRangeEGP: { low: r2(lo), high: r2(hi) },
    overTopOfRangeEGP: r2(over),
    overTopOfRangePercent: r2(pct),
    verdict,
    message: messages[verdict],
  });
}

async function sellNow(inputs) {
  const L = await getLive();
  const karat = enumIn(inputs, 'karat', KARATS, { def: 'K21' });
  const w = numIn(inputs, 'weightGrams', { gt: 0, max: 100000, required: true });
  const paid = numIn(inputs, 'paidEGP', { gt: 0, max: 1e11, required: true });
  const d = numIn(inputs, 'deductionPercent', { min: 0, max: 50, def: 0 });
  const buy = priceIn(inputs, 'buyPrice') ?? L.prices[karat].buy;
  const sell = priceIn(inputs, 'sellPrice') ?? L.prices[karat].sell;
  const sellNowV = w * buy * (1 - d / 100), res = sellNowV - paid, resPct = res / paid * 100;
  const be = paid / (w * (1 - d / 100)), rise = Math.max(0, be / buy - 1) * 100;
  const prem = paid - w * sell, loss = w * (sell - buy);
  let verdict, message;
  if (res >= 0.005) { verdict = 'profit'; message = `لو بعت دلوقتي هتكسب حوالي ${fmt(res, 0)} ج (${fmt(resPct, 1)}%).`; }
  else if (res <= -0.005) {
    verdict = 'loss';
    message = `لو بعت دلوقتي هتخسر حوالي ${fmt(-res, 0)} ج (${fmt(-resPct, 1)}%). علشان تتعادل لازم سعر شراء الجرام عند الصايغ يوصل ${fmt(be, 2)} ج بدل ${fmt(buy, 2)} ج النهارده، يعني فرق ${fmt(rise, 2)}%. الحاسبة بتقول الشرط ده بس، ومش بتتوقع إنه هيحصل.`;
  } else { verdict = 'break_even'; message = 'لو بعت دلوقتي هتطلع متعادل تقريبًا.'; }
  return stamp(L, {
    karat, weightGrams: w, paidEGP: paid, deductionPercent: d, buyPriceUsed: buy, sellPriceUsed: sell,
    sellNowValueEGP: r2(sellNowV),
    profitOrLossEGP: r2(res),
    profitOrLossPercent: r2(resPct),
    breakEvenBuyPricePerGram: r2(be),
    todayBuyPricePerGram: r2(buy),
    riseNeededPercent: r2(rise),
    paidAboveGoldValueAtSellPriceEGP: r2(prem),
    buySellSpreadCostEGP: r2(loss),
    verdict,
    message,
    note: 'الصنعة (المصنعية) والفرق بين سعر البيع وسعر الشراء هما سبب إن البيع بعد الشراء مباشرة بيخسر.',
  });
}

async function unitConvert(inputs) {
  const L = await getLive();
  const unit = enumIn(inputs, 'unit', Object.keys(UNIT_GRAMS), { required: true });
  const amount = numIn(inputs, 'amount', { gt: 0, max: 1e9, required: true });
  const pound = POUND_UNITS.includes(unit);
  const karat = pound ? 'K21' : enumIn(inputs, 'karat', KARATS, { def: 'K21' });
  const buy = priceIn(inputs, 'buyPrice') ?? L.prices[karat].buy;
  const sell = priceIn(inputs, 'sellPrice') ?? L.prices[karat].sell;
  const g = amount * UNIT_GRAMS[unit], pure = g * PURITY[karat];
  return stamp(L, {
    amount, unit, karatUsed: karat,
    grams: r2(g),
    kilograms: round(g / 1000, 4),
    troyOunces: round(g / 31.1034768, 4),
    tolas: round(g / 11.6638038, 4),
    goldPounds: round(pure / (8 * 0.875), 4),
    pure24kGrams: r2(pure),
    buyPriceUsed: buy, sellPriceUsed: sell,
    valueAtSellPriceEGP: r2(g * sell),
    valueAtBuyPriceEGP: r2(g * buy),
    note: 'جنيه الذهب = 8 جم عيار 21؛ دايمًا بيتحسب عيار 21.',
  });
}

async function budget(inputs) {
  const L = await getLive();
  const { karat, kind } = kindKarat(L, inputs, { kindDef: 'SIMPLE_JEWELRY', karatDef: 'K21' });
  const b = numIn(inputs, 'budgetEGP', { gt: 0, max: 1e11, required: true });
  const sell = priceIn(inputs, 'sellPrice') ?? L.prices[karat].sell;
  const r = rangeRow(L, kind, karat), vat = L.vat;
  const lowG = sell + r[0] * (1 + vat), highG = sell + r[1] * (1 + vat);
  const gMax = b / lowG, gMin = b / highG;
  const out = {
    karat, kind, budgetEGP: b, sellPriceUsed: sell,
    makingPerGramRange: { min: r[0], max: r[1] },
    pricePerGramWithMakingAndVatEGP: { low: r2(lowG), high: r2(highG) },
    gramsAffordable: { min: r2(gMin), max: r2(gMax) },
    message: `بميزانية ${fmt(b, 0)} ج تقدر تشتري تقريبًا من ${fmt(gMin, 2)} إلى ${fmt(gMax, 2)} جرام عيار ${karat.slice(1)}. الرقم الأعلى لو المصنعية في أقل المعتاد، والأقل لو في أعلاها. المصنعية الفعلية بتتحدد في المحل.`,
  };
  if (kind === 'BAR') {
    out.bars = L.bars.slice().sort((a, c) => a.grams - c.grams).map((x) => {
      const price = x.grams * sell + x.grams * feeForBar(L, x.grams) * (1 + vat);
      const cnt = Math.floor(b / price);
      return { grams: x.grams, priceEGP: r2(price), count: cnt, leftoverEGP: cnt > 0 ? r2(b - cnt * price) : null, fitsBudget: cnt > 0 };
    });
  }
  return stamp(L, out);
}

async function compare(inputs) {
  const L = await getLive();
  const { karat, kind } = kindKarat(L, inputs, { kindDef: 'SIMPLE_JEWELRY', karatDef: 'K21' });
  const amt = numIn(inputs, 'amountEGP', { gt: 0, max: 1e11, required: true });
  const yearsRaw = numIn(inputs, 'years', { min: 1, max: 10, required: true });
  const years = Math.round(yearsRaw);
  const goldChange = numIn(inputs, 'goldChangePercentPerYear', { min: -100, max: 1000 });
  const certRate = numIn(inputs, 'certRatePercentPerYear', { min: -100, max: 1000 });
  const usdChange = numIn(inputs, 'usdChangePercentPerYear', { min: -100, max: 1000 });
  const spreadPct = numIn(inputs, 'usdSpreadPercent', { min: 0, max: 20, def: 1 });
  const buy = priceIn(inputs, 'buyPrice') ?? L.prices[karat].buy;
  const sell = priceIn(inputs, 'sellPrice') ?? L.prices[karat].sell;
  let mk = numIn(inputs, 'makingPerGram', { min: 0, max: 5000 });
  if (mk === undefined) {
    if (kind === 'BAR') mk = feeForBar(L, amt / sell);
    else { const r = rangeRow(L, kind, karat); mk = Math.round(((r[0] + r[1]) / 2) * 100) / 100; }
  }
  const sp = spreadPct / 100, vat = L.vat;
  const per = sell + mk * (1 + vat), grams = amt / per;
  const line = (fin) => {
    const p = fin - amt;
    return {
      finalValueEGP: r2(fin), profitEGP: r2(p), profitPercent: r2(p / amt * 100),
      effectiveYearlyPercent: r2((Math.pow(Math.max(fin, 0) / amt, 1 / years) - 1) * 100),
    };
  };
  const out = { karat, kind, amountEGP: amt, years, makingPerGramUsed: mk, buyPriceUsed: buy, sellPriceUsed: sell, usdSpreadPercent: spreadPct };
  const notes = [];
  if (goldChange !== undefined) {
    const pa = buy * Math.pow(Math.max(0, 1 + goldChange / 100), years);
    out.gold = { ...line(grams * pa), gramsBought: r2(grams), pricePerGramPaidEGP: r2(per), buyPricePerGramAfterYearsEGP: r2(pa), assumedChangePercentPerYear: goldChange };
    notes.push(`الذهب: بالمبلغ ده بتشتري ${fmt(grams, 2)} جرام بسعر ${fmt(per)} ج للجرام شامل المصنعية والضريبة، وبعد ${years} سنة بتتحسب بسعر الشراء ${fmt(pa)} ج للجرام.`);
  } else out.gold = null;
  if (certRate !== undefined) out.certificates = { ...line(amt * Math.pow(1 + certRate / 100, years)), assumedRatePercentPerYear: certRate };
  else out.certificates = null;
  if (usdChange !== undefined) {
    out.dollar = { ...line(amt * (1 - sp) * Math.pow(Math.max(0, 1 + usdChange / 100), years) * (1 - sp)), assumedChangePercentPerYear: usdChange };
    notes.push(`الدولار: الحسبة بتخصم ${fmt(spreadPct, 1)}% عند الشراء و${fmt(spreadPct, 1)}% عند البيع (افتراض تقدر تغيّره).`);
  } else out.dollar = null;
  out.missingInputs = [
    goldChange === undefined && 'goldChangePercentPerYear',
    certRate === undefined && 'certRatePercentPerYear',
    usdChange === undefined && 'usdChangePercentPerYear',
  ].filter(Boolean);
  out.notes = notes;
  out.warning = 'النتائج مبنية على الأرقام المدخلة فقط، وده سيناريو مش توقع: تغيّر الذهب والدولار الفعلي مجهول مسبقًا، والشهادات ليها شروط البنك، والذهب فيه فرق البيع والشراء والمصنعية (محسوبين في الحسبة).';
  return stamp(L, out);
}

async function exchange(inputs) {
  const L = await getLive();
  const ow = numIn(inputs, 'oldWeightGrams', { gt: 0, max: 100000, required: true });
  const nw = numIn(inputs, 'newWeightGrams', { gt: 0, max: 100000, required: true });
  const ok = enumIn(inputs, 'oldKarat', KARATS, { required: true });
  const nk = enumIn(inputs, 'newKarat', KARATS, { required: true });
  const dedPct = numIn(inputs, 'goldsmithDiscountPercent', { min: 0, max: 50, def: 0 });
  const mk = numIn(inputs, 'makingPerGram', { min: 0, max: 5000, def: 0 });
  const dir = enumIn(inputs, 'cashDirection', ['none', 'received', 'paid'], { def: 'none' });
  const amt = numIn(inputs, 'cashAmountEGP', { min: 0, max: 1e11, def: 0 });
  if (dir !== 'none' && !(amt > 0)) throw new Error('cashAmountEGP must be greater than 0 when cashDirection is received or paid');
  const buy = priceIn(inputs, 'buyPrice') ?? L.prices[ok].buy;   // goldsmith's BUY price of the old karat
  const sell = priceIn(inputs, 'sellPrice') ?? L.prices[nk].sell; // goldsmith's SELL price of the new karat
  const ded = dedPct / 100, VAT = 0.14;
  const oldBefore = ow * buy, oldValue = oldBefore * (1 - ded);
  const newGold = nw * sell, making = nw * mk, vat = making * VAT, newTotal = newGold + making + vat;
  const fair = oldValue - newTotal;
  const actual = dir === 'received' ? amt : dir === 'paid' ? -amt : 0;
  const gap = actual - fair, gapPct = newTotal > 0 ? gap / newTotal * 100 : 0;
  const tol = Math.max(200, newTotal * 0.02);
  const verdict = (gap >= -tol && gap <= tol) ? 'fair' : gap > tol ? 'generous' : gap >= -newTotal * 0.08 ? 'slightly_unfair' : 'unfair';
  const z = fmt(gap, 0), pc = fmt(gapPct, 1) + '%';
  const message = verdict === 'fair' ? `الصفقة عادلة تقريبًا (فرق ${z} ج)`
    : verdict === 'slightly_unfair' ? `خدت أقل من حقك بحوالي ${z} ج (${pc})`
    : verdict === 'unfair' ? `الفرق كبير: خدت أقل من حقك بحوالي ${z} ج (${pc})`
    : `خدت أكتر من الحسبة بحوالي ${z} ج`;
  return stamp(L, {
    oldWeightGrams: ow, oldKarat: ok, newWeightGrams: nw, newKarat: nk,
    goldsmithDiscountPercent: dedPct, makingPerGram: mk, cashDirection: dir, cashAmountEGP: amt,
    buyPriceUsed: buy, sellPriceUsed: sell, vatRateOnMaking: VAT,
    oldValueBeforeDiscountEGP: r2(oldBefore),
    discountEGP: r2(oldBefore - oldValue),
    oldValueEGP: r2(oldValue),
    newGoldValueEGP: r2(newGold),
    makingChargeEGP: r2(making),
    vatOnMakingEGP: r2(vat),
    newTotalEGP: r2(newTotal),
    fairDifferenceEGP: r2(fair),
    fairDifferenceMeaning: fair >= 0 ? 'receive' : 'pay',
    actualEGP: r2(actual),
    gapEGP: r2(gap),
    gapPercentOfNewValue: r2(gapPct),
    toleranceEGP: r2(tol),
    verdict,
    message,
    pureGoldGivenGrams: r2(ow * PURITY[ok]),
    pureGoldReceivedGrams: r2(nw * PURITY[nk]),
  });
}

// ---------- proxies ----------
async function asOf() {
  try { return (await getLive()).at; } catch (e) { return null; }
}
async function withMeta(data, extra) {
  return { ...data, ...(extra || {}), pricesAsOf: await asOf(), source: SOURCE };
}

async function zakat(inputs) {
  const hold = inputs.holdings === undefined || inputs.holdings === null ? [] : inputs.holdings;
  if (!Array.isArray(hold)) throw new Error('holdings must be an array');
  if (hold.length > 100) throw new Error('holdings must have at most 100 items');
  const holdings = hold.map((h, i) => {
    if (!isObj(h)) throw new Error(`holdings[${i}] must be an object`);
    const metalType = enumIn(h, 'metalType', ['GOLD', 'SILVER'], { required: true });
    const weightGrams = numIn(h, 'weightGrams', { min: 0.0001, max: 1000000, required: true });
    const o = { metalType, weightGrams };
    if (metalType === 'GOLD') {
      if (!h.karat) throw new Error(`holdings[${i}].karat is required for GOLD (K24, K21 or K18)`);
      o.karat = enumIn(h, 'karat', KARATS);
    } else if (h.karat) throw new Error(`holdings[${i}].karat must not be provided for SILVER`);
    if (h.worn !== undefined && h.worn !== null) {
      if (typeof h.worn !== 'boolean') throw new Error(`holdings[${i}].worn must be true or false`);
      o.worn = h.worn;
    }
    return o;
  });
  const cashEGP = numIn(inputs, 'cashEGP', { min: 0, max: 100000000000 });
  let cashItems;
  if (inputs.cashItems !== undefined && inputs.cashItems !== null) {
    if (!Array.isArray(inputs.cashItems)) throw new Error('cashItems must be an array');
    if (inputs.cashItems.length > 20) throw new Error('cashItems must have at most 20 rows');
    cashItems = inputs.cashItems.map((c, i) => {
      if (!isObj(c) || typeof c.currency !== 'string' || !c.currency) throw new Error(`cashItems[${i}].currency is required (e.g. USD)`);
      return { currency: c.currency.toUpperCase(), amount: numIn(c, 'amount', { gt: 0, max: 1e12, required: true }) };
    });
  }
  if (!holdings.length && !(cashEGP > 0) && !(cashItems && cashItems.length)) throw new Error('provide holdings, cashEGP or cashItems');
  const school = enumIn(inputs, 'school', SCHOOLS);
  const body = { holdings };
  if (cashEGP !== undefined) body.cashEGP = cashEGP;
  if (cashItems) body.cashItems = cashItems;
  if (school) body.school = school;
  const data = await fetchJson('calculators/zakat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return withMeta(data, { date: data.calculatedAt });
}

async function nisab() {
  const data = await fetchJson('calculators/zakat/nisab');
  return withMeta(data, { date: data.calculatedAt });
}

async function makingCharge(inputs) {
  const karat = enumIn(inputs, 'karat', KARATS, { required: true });
  const itemType = enumIn(inputs, 'itemType', KINDS, { required: true });
  if (!KINDS_BY_KARAT[karat].includes(itemType)) throw new Error(`itemType ${itemType} is not offered in ${karat} (K24: BAR/COIN; K21 and K18: SIMPLE_JEWELRY/MEDIUM_JEWELRY/COMPLEX_JEWELRY)`);
  const weightGrams = numIn(inputs, 'weightGrams', { min: 0.01, max: 100000, required: true });
  const mk = numIn(inputs, 'craftsmanshipPerGram', { min: 0, max: 5000 });
  const body = { karat, itemType, weightGrams };
  if (mk !== undefined) body.craftsmanshipPerGram = mk;
  const data = await fetchJson('calculators/craftsmanship', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return withMeta(data, { date: data.calculatedAt, disclaimer: DISCLAIMER });
}

async function bullion() {
  const data = await fetchJson('calculators/bullion');
  return withMeta(data, { date: data.calculatedAt, disclaimer: DISCLAIMER });
}

// ---------- catalogue ----------
const karatIn = (description, def) => ({ type: 'string', enum: KARATS, description, ...(def ? { default: def } : {}) });
const kindIn = (def) => ({ type: 'string', enum: KINDS, description: 'Item type. K24 offers BAR/COIN; K21 and K18 offer SIMPLE_JEWELRY/MEDIUM_JEWELRY/COMPLEX_JEWELRY.', default: def });
const positive = (description, extra) => ({ type: 'number', description, required: true, ...(extra || {}) });
const priceOverride = (which, what) => ({ type: 'number', description: `Optional override of the ${which} price in EGP per gram (${what}); default is the live qintar.app price.` });

const list = [
  {
    id: 'gold-zakat',
    title: 'حاسبة زكاة الذهب والفضة',
    description: 'Calls the Qintar zakat calculator for gold, silver and cash holdings and returns its result as-is; use it to see whether holdings reach the nisab and what the API computes as due.',
    inputs: {
      holdings: { type: 'array', description: 'Items: { metalType: "GOLD"|"SILVER", karat: "K24"|"K21"|"K18" (gold only, required for gold), weightGrams (0.0001..1000000), worn?: boolean }. Max 100.' },
      cashEGP: { type: 'number', description: 'Cash and savings in EGP (0..100000000000).' },
      cashItems: { type: 'array', description: 'Cash in other currencies: [{ currency: "USD", amount: 1000 }], max 20 rows; converted by the API at its rates.' },
      school: { type: 'string', enum: SCHOOLS, description: 'Optional school setting passed to the API (its default is HANAFI).' },
    },
    output: 'The Qintar zakat result (per-metal nisab check, zakat due in EGP and grams, cash part, breakdown, prices, calculatedAt) plus date, pricesAsOf, source.',
  },
  {
    id: 'gold-nisab',
    title: 'نصاب الزكاة بأسعار اليوم',
    description: 'Returns the current gold (85 g of 24K) and silver (595 g) nisab thresholds in grams and EGP from the Qintar API; use it to know the zakat threshold today.',
    inputs: {},
    output: 'goldGrams, goldEGP, silverGrams, silverEGP, gold24PerGram, silverPerGram, calculatedAt (as returned by the API) plus date, pricesAsOf, source.',
  },
  {
    id: 'gold-making-charge',
    title: 'حاسبة المصنعية',
    description: 'Calls the Qintar craftsmanship calculator to show what a gold piece really costs (gold, making charge, 14% VAT on the charge) and what is lost on resale; use before buying jewelry, coins or bars.',
    inputs: {
      karat: { ...karatIn('Gold karat.'), required: true },
      itemType: { type: 'string', enum: KINDS, required: true, description: 'K24: BAR or COIN; K21 and K18: SIMPLE_JEWELRY, MEDIUM_JEWELRY or COMPLEX_JEWELRY.' },
      weightGrams: positive('Weight in grams (0.01..100000).'),
      craftsmanshipPerGram: { type: 'number', description: 'Optional making charge in EGP per gram (0..5000) to use instead of the typical one.' },
    },
    output: 'The API result: goldValue, craftsmanshipPerGram/Total, vatAmount, totalBuyPrice, resaleValue, lossOnResale and breakdown, typical range and where the fee falls, plus date, pricesAsOf, source, disclaimer.',
  },
  {
    id: 'gold-bullion-prices',
    title: 'أسعار السبائك وجنيهات الذهب',
    description: 'Returns today\'s price of gold pounds (8, 4, 2 g of K21) and K24 bars (1 to 100 g) with estimated making charges, from the Qintar API; use it to compare bar and coin prices.',
    inputs: {},
    output: 'items[] (id, kind, karat, grams, goldValue, resaleValue, makingPerGram, makingTotal, priceLow, priceHigh), vatRate, makingChargesSource, calculatedAt plus date, pricesAsOf, source, disclaimer.',
  },
  {
    id: 'gold-fair-price-check',
    title: 'السعر ده عادل؟',
    description: 'Checks whether the total paid for a gold bar, coin or jewelry piece is within the usual price range (gold at today\'s selling price plus typical making charge and VAT on it); use after or before buying.',
    inputs: {
      karat: karatIn('Gold karat.', 'K24'),
      kind: kindIn('BAR'),
      weightGrams: positive('Weight in grams.'),
      paidEGP: positive('Total paid in EGP.'),
      makingPerGram: { type: 'number', description: 'Optional making charge in EGP per gram; replaces the typical range.' },
      sellPrice: priceOverride('selling', 'what a buyer pays the goldsmith'),
    },
    output: 'goldValueEGP, fairRangeEGP {low, high}, overTopOfRangeEGP/Percent, verdict (below_gold|fair|slightly_high|high|very_high) with an Arabic message, pricesAsOf, source, disclaimer.',
  },
  {
    id: 'gold-sell-now',
    title: 'لو بعت دلوقتي هاخد كام؟',
    description: 'Computes what gold bought earlier would fetch if sold now at the goldsmith\'s buy price (after an optional discount), the profit or loss, and the break-even buy price; use to decide whether to sell.',
    inputs: {
      karat: karatIn('Gold karat.', 'K21'),
      weightGrams: positive('Weight in grams.'),
      paidEGP: positive('Total paid originally, in EGP.'),
      deductionPercent: { type: 'number', description: 'Percent the goldsmith deducts when buying back (0..50).', default: 0 },
      buyPrice: priceOverride('buy', 'what the goldsmith pays a seller'),
      sellPrice: priceOverride('selling', 'used only for the premium and spread lines'),
    },
    output: 'sellNowValueEGP, profitOrLossEGP/Percent, breakEvenBuyPricePerGram, riseNeededPercent, paidAboveGoldValueAtSellPriceEGP, buySellSpreadCostEGP, verdict (profit|loss|break_even), message, pricesAsOf, source, disclaimer.',
  },
  {
    id: 'gold-unit-convert',
    title: 'تحويل الجرام والجنيه الذهب والأوقية',
    description: 'Converts an amount between grams, kilograms, troy ounces, tolas and gold pounds (8 g of K21) and values it at today\'s buy and sell prices; use for quick unit questions.',
    inputs: {
      amount: positive('Quantity of the chosen unit.'),
      unit: { type: 'string', enum: Object.keys(UNIT_GRAMS), required: true, description: 'gram, kilogram, ounce, tola, pound (8 g K21), halfPound (4 g), quarterPound (2 g).' },
      karat: karatIn('Karat of the gold; ignored for pound units, which are always K21.', 'K21'),
      buyPrice: priceOverride('buy', 'what the goldsmith pays'),
      sellPrice: priceOverride('selling', 'what you pay'),
    },
    output: 'grams, kilograms, troyOunces, tolas, goldPounds, pure24kGrams, valueAtSellPriceEGP, valueAtBuyPriceEGP, pricesAsOf, source, disclaimer.',
  },
  {
    id: 'gold-budget',
    title: 'أقدر أشتري كام جرام بميزانيتي؟',
    description: 'Estimates how many grams of gold a budget buys at today\'s selling price plus the usual making charge and VAT, with a table of bar sizes for K24 bars; use when planning a purchase.',
    inputs: {
      budgetEGP: positive('Budget in EGP.'),
      karat: karatIn('Gold karat.', 'K21'),
      kind: kindIn('SIMPLE_JEWELRY'),
      sellPrice: priceOverride('selling', 'what you pay'),
    },
    output: 'gramsAffordable {min, max}, pricePerGramWithMakingAndVatEGP, makingPerGramRange, bars[] (for BAR: price, count, leftover per size), pricesAsOf, source, disclaimer.',
  },
  {
    id: 'gold-compare-investments',
    title: 'ذهب ولا شهادات ولا دولار؟',
    description: 'Runs an input-driven scenario comparing gold, bank certificates and dollars over 1-10 years from rates the caller types in; it is not a forecast, use it to see how assumptions play out.',
    inputs: {
      amountEGP: positive('Amount to invest in EGP.'),
      years: positive('Number of years (1..10).'),
      goldChangePercentPerYear: { type: 'number', description: 'Assumed yearly change of the goldsmith buy price, in percent. Omit to skip the gold line.' },
      certRatePercentPerYear: { type: 'number', description: 'Certificate yearly rate in percent (compounded yearly). Omit to skip the certificates line.' },
      usdChangePercentPerYear: { type: 'number', description: 'Assumed yearly change of EGP per USD, in percent. Omit to skip the dollar line.' },
      usdSpreadPercent: { type: 'number', description: 'Assumed dollar buy/sell gap per side, percent (0..20).', default: 1 },
      karat: karatIn('Gold karat.', 'K21'),
      kind: kindIn('SIMPLE_JEWELRY'),
      makingPerGram: { type: 'number', description: 'Making charge EGP per gram; default is the bar fee tier, or the middle of the typical range.' },
      buyPrice: priceOverride('buy', 'goldsmith buy price used for the exit'),
      sellPrice: priceOverride('selling', 'price used at entry'),
    },
    output: 'gold / certificates / dollar each with finalValueEGP, profitEGP/Percent, effectiveYearlyPercent (null when its rate was not given), notes, warning, pricesAsOf, source, disclaimer.',
  },
  {
    id: 'gold-exchange-old-for-new',
    title: 'استبدال الذهب القديم بجديد',
    description: 'Checks whether the cash difference paid or received when swapping old gold for new gold at a goldsmith is fair: old value at the buy price minus the discount, against new gold at the sell price plus making charge and 14% VAT on the charge.',
    inputs: {
      oldWeightGrams: positive('Weight of the old gold in grams.'),
      oldKarat: { ...karatIn('Karat of the old gold.'), required: true },
      newWeightGrams: positive('Weight of the new gold in grams.'),
      newKarat: { ...karatIn('Karat of the new gold.'), required: true },
      goldsmithDiscountPercent: { type: 'number', description: 'Percent the goldsmith takes off the old gold (0..50).', default: 0 },
      makingPerGram: { type: 'number', description: 'Making charge on the new gold, EGP per gram (0..5000).', default: 0 },
      cashDirection: { type: 'string', enum: ['none', 'received', 'paid'], description: 'What actually happened in cash: none, you received money, or you paid money.', default: 'none' },
      cashAmountEGP: { type: 'number', description: 'Cash amount actually received or paid (required > 0 unless cashDirection is none).', default: 0 },
      buyPrice: priceOverride('buy', 'of the OLD karat, what the goldsmith pays'),
      sellPrice: priceOverride('selling', 'of the NEW karat, what you pay'),
    },
    output: 'oldValueEGP, newTotalEGP (gold + making + VAT), fairDifferenceEGP (+receive / -pay), gapEGP, gapPercentOfNewValue, verdict (fair|generous|slightly_unfair|unfair), message, pure gold grams in/out, pricesAsOf, source, disclaimer.',
  },
];

const handlers = {
  'gold-zakat': zakat,
  'gold-nisab': nisab,
  'gold-making-charge': makingCharge,
  'gold-bullion-prices': bullion,
  'gold-fair-price-check': fairPrice,
  'gold-sell-now': sellNow,
  'gold-unit-convert': unitConvert,
  'gold-budget': budget,
  'gold-compare-investments': compare,
  'gold-exchange-old-for-new': exchange,
};

async function run(id, inputs) {
  const h = handlers[id];
  if (!h) throw new Error(`Unknown gold tool: ${id}`);
  return h(checkInputs(inputs));
}

module.exports = { list, run };
