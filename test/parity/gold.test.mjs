// Verifies lib/calc/tools-gold.js: local calculators vs the REAL qintar.app web pages (headless Chromium),
// proxied calculators vs a direct curl of the Qintar API.
// Run: node test/tools-gold.test.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core'; // dev-only: npm i -D playwright-core, then install a Chromium (or set CHROME_PATH)

const require = createRequire(import.meta.url);
const gold = require('../../src/tools-gold.js');
const BASE = 'https://qintar.app/tools/';
const EXE = process.env.CHROME_PATH || undefined;

const results = [];
function record(calc, set, ok, detail) {
  results.push({ calc, set, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${calc} #${set}${ok ? '' : '  ' + detail}`);
}
const AR = '٠١٢٣٤٥٦٧٨٩';
const nums = (s) => (String(s).replace(/[٠-٩]/g, (d) => AR.indexOf(d)).replace(/,/g, '').replace(/−/g, '-').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
const first = (s) => nums(s)[0];

function checker() {
  const errs = [];
  const near = (label, a, b, tol) => {
    if (!(Math.abs(a - b) <= tol)) errs.push(`${label}: run()=${a} page=${b} (tol ${tol})`);
  };
  return { near, errs, eq: (label, a, b) => { if (a !== b) errs.push(`${label}: run()=${a} page=${b}`); } };
}

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

// Open a page, wait for live prices, set selects, read displayed prices, fill inputs like a user.
async function openPage(name, { selects = {}, inputs = {} }) {
  const page = await browser.newPage();
  await page.goto(BASE + name + '.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /آخر تحديث/.test(document.getElementById('prices').textContent), null, { timeout: 15000 });
  for (const [id, v] of Object.entries(selects)) await page.selectOption('#' + id, v);
  for (const [id, v] of Object.entries(inputs)) await page.fill('#' + id, String(v));
  await page.waitForTimeout(150);
  return page;
}
const val = (page, id) => page.$eval('#' + id, (e) => e.value);
const rows = (page, id = 'rows') => page.$$eval('#' + id + ' tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
const text = (page, id) => page.$eval('#' + id, (e) => e.textContent);

// ---------- 1. fair price ----------
async function testFair(i, s) {
  const page = await openPage('gold-fair-price-checker', { selects: { karat: s.karat, kind: s.kind }, inputs: { w: s.w, paid: s.paid, ...(s.mk !== undefined ? { mk: s.mk } : {}) } });
  const pSell = Number(await val(page, 'pSell'));
  const r = await gold.run('gold-fair-price-check', { karat: s.karat, kind: s.kind, weightGrams: s.w, paidEGP: s.paid, sellPrice: pSell, ...(s.mk !== undefined ? { makingPerGram: s.mk } : {}) });
  const rw = await rows(page);
  const cls = await page.$eval('#verdict', (e) => e.className);
  const c = checker();
  c.near('goldValue', r.goldValueEGP, first(rw[0][1]), 0.006);
  const fr = nums(rw[3][1]);
  c.near('fairLow', r.fairRangeEGP.low, fr[0], 0.006);
  c.near('fairHigh', r.fairRangeEGP.high, fr[fr.length - 1], 0.006);
  c.near('|over|', Math.abs(r.overTopOfRangeEGP), nums(rw[5][1])[0], 0.006);
  c.near('|overPct|', Math.abs(r.overTopOfRangePercent), nums(rw[5][1])[1], 0.06);
  const pageVerdict = cls.includes('unfair') ? 'unfair-ish' : cls.includes('fair') ? 'fair' : 'other';
  const map = { below_gold: 'unfair-ish', fair: 'fair', slightly_high: 'unfair-ish', high: 'unfair-ish', very_high: 'unfair-ish' };
  c.eq('verdict class', map[r.verdict], pageVerdict);
  // verdict text distinguishes the finer levels
  const vt = await text(page, 'verdict');
  const fine = { below_gold: 'أقل من قيمة الذهب', fair: 'السعر في النطاق المعتاد', slightly_high: null, high: null, very_high: 'أعلى بوضوح' };
  if (fine[r.verdict] && !vt.includes(fine[r.verdict])) c.errs.push(`verdict text "${vt.slice(0, 60)}" vs ${r.verdict}`);
  if (r.verdict === 'very_high' && !vt.includes('أعلى بوضوح')) c.errs.push('very_high text');
  if (r.verdict === 'high' && !(vt.includes('يستاهل تسأل') )) c.errs.push('high text');
  if (r.verdict === 'slightly_high' && !vt.includes('فرق صغير') && !vt.includes('يستاهل')) c.errs.push('slightly_high text');
  record('gold-fair-price-check', i, c.errs.length === 0, c.errs.join('; ') + ` [${r.verdict}]`);
  await page.close();
}

// ---------- 2. sell now ----------
async function testSell(i, s) {
  const page = await openPage('gold-break-even-calculator', { selects: { karat: s.karat }, inputs: { w: s.w, paid: s.paid, ded: s.ded } });
  const pBuy = Number(await val(page, 'pBuy')), pSell = Number(await val(page, 'pSell'));
  const r = await gold.run('gold-sell-now', { karat: s.karat, weightGrams: s.w, paidEGP: s.paid, deductionPercent: s.ded, buyPrice: pBuy, sellPrice: pSell });
  const rw = await rows(page);
  const c = checker();
  c.near('sellNow', r.sellNowValueEGP, first(rw[1][1]), 0.006);
  c.near('|result|', Math.abs(r.profitOrLossEGP), nums(rw[2][1])[0], 0.006);
  c.near('|resultPct|', Math.abs(r.profitOrLossPercent), nums(rw[2][1])[1], 0.06);
  c.near('breakEven', r.breakEvenBuyPricePerGram, first(rw[3][1]), 0.006);
  c.near('rise', r.riseNeededPercent, first(rw[5][1]), 0.006);
  c.near('premium', r.paidAboveGoldValueAtSellPriceEGP, first(rw[6][1]), 0.006);
  c.near('spreadLoss', r.buySellSpreadCostEGP, first(rw[7][1]), 0.006);
  record('gold-sell-now', i, c.errs.length === 0, c.errs.join('; '));
  await page.close();
}

// ---------- 3. unit converter ----------
async function testUnit(i, s) {
  const page = await openPage('gold-unit-converter', { selects: { unit: s.unit, ...(s.karat ? { karat: s.karat } : {}) }, inputs: { amount: s.amount } });
  const pBuy = Number(await val(page, 'pBuy')), pSell = Number(await val(page, 'pSell'));
  const r = await gold.run('gold-unit-convert', { amount: s.amount, unit: s.unit, ...(s.karat ? { karat: s.karat } : {}), buyPrice: pBuy, sellPrice: pSell });
  const rw = await rows(page);
  const c = checker();
  c.near('grams', r.grams, first(rw[0][1]), 0.006);
  c.near('kg', r.kilograms, first(rw[1][1]), 0.00006);
  c.near('ounce', r.troyOunces, first(rw[2][1]), 0.00006);
  c.near('tola', r.tolas, first(rw[3][1]), 0.00006);
  c.near('pounds', r.goldPounds, first(rw[4][1]), 0.00006);
  c.near('pure24', r.pure24kGrams, first(rw[5][1]), 0.006);
  c.near('sellValue', r.valueAtSellPriceEGP, first(rw[6][1]), 0.006);
  c.near('buyValue', r.valueAtBuyPriceEGP, first(rw[7][1]), 0.006);
  record('gold-unit-convert', i, c.errs.length === 0, c.errs.join('; '));
  await page.close();
}

// ---------- 4. budget ----------
async function testBudget(i, s) {
  const page = await openPage('gold-budget-calculator', { selects: { karat: s.karat, kind: s.kind }, inputs: { budget: s.budget } });
  const pSell = Number(await val(page, 'pSell'));
  const r = await gold.run('gold-budget', { karat: s.karat, kind: s.kind, budgetEGP: s.budget, sellPrice: pSell });
  const rw = await rows(page);
  const c = checker();
  const pg = nums(rw[1][1]);
  c.near('perGramLow', r.pricePerGramWithMakingAndVatEGP.low, pg[0], 0.006);
  c.near('perGramHigh', r.pricePerGramWithMakingAndVatEGP.high, pg[1], 0.006);
  const gr = nums(rw[2][1]);
  c.near('gramsMin', r.gramsAffordable.min, gr[0], 0.006);
  c.near('gramsMax', r.gramsAffordable.max, gr[1], 0.006);
  if (s.kind === 'BAR') {
    const br = await rows(page, 'barRows');
    c.eq('bar rows', r.bars.length, br.length);
    r.bars.forEach((b, k) => {
      const row = br[k];
      c.near(`bar${b.grams} grams`, b.grams, first(row[0]), 0.06);
      c.near(`bar${b.grams} price`, b.priceEGP, first(row[1]), 0.5);
      c.near(`bar${b.grams} count`, b.count, /\d/.test(row[2]) ? first(row[2]) : 0, 0);
      if (b.count > 0) c.near(`bar${b.grams} left`, b.leftoverEGP, first(row[3]), 0.5);
    });
  }
  record('gold-budget', i, c.errs.length === 0, c.errs.join('; '));
  await page.close();
}

// ---------- 5. compare ----------
async function testCompare(i, s) {
  const page = await openPage('gold-vs-certificates-vs-dollar', { selects: { karat: s.karat, kind: s.kind }, inputs: { amount: s.amount, years: s.years, g: s.g, c: s.c, u: s.u, ...(s.spread !== undefined ? { spread: s.spread } : {}), ...(s.mk !== undefined ? { mk: s.mk } : {}) } });
  const pBuy = Number(await val(page, 'pBuy')), pSell = Number(await val(page, 'pSell'));
  const r = await gold.run('gold-compare-investments', {
    karat: s.karat, kind: s.kind, amountEGP: s.amount, years: s.years,
    goldChangePercentPerYear: s.g, certRatePercentPerYear: s.c, usdChangePercentPerYear: s.u,
    ...(s.spread !== undefined ? { usdSpreadPercent: s.spread } : {}), ...(s.mk !== undefined ? { makingPerGram: s.mk } : {}),
    buyPrice: pBuy, sellPrice: pSell,
  });
  const rw = await rows(page);
  const c = checker();
  [['gold', r.gold], ['certificates', r.certificates], ['dollar', r.dollar]].forEach(([name, o], k) => {
    const row = rw[k];
    c.near(name + ' final', o.finalValueEGP, first(row[1]), 0.5);
    const pr = nums(row[2]);
    c.near(name + ' profit', o.profitEGP, pr[0], 0.5);
    c.near(name + ' profit%', o.profitPercent, pr[1], 0.06);
    c.near(name + ' eff%', o.effectiveYearlyPercent, first(row[3]), 0.006);
  });
  record('gold-compare-investments', i, c.errs.length === 0, c.errs.join('; ') + ` [page mk=${''}]`);
  await page.close();
}

// ---------- 6. exchange ----------
async function testExchange(i, s) {
  const page = await openPage('gold-exchange-calculator', {
    selects: { oldK: s.oldK, newK: s.newK, cashDir: s.dir },
    inputs: { oldW: s.oldW, newW: s.newW, ded: s.ded, mk: s.mk, ...(s.dir !== 'none' ? { cashAmt: s.amt } : {}) },
  });
  const pBuy = Number(await val(page, 'pBuy')), pSell = Number(await val(page, 'pSell'));
  const r = await gold.run('gold-exchange-old-for-new', {
    oldWeightGrams: s.oldW, oldKarat: 'K' + s.oldK, newWeightGrams: s.newW, newKarat: 'K' + s.newK,
    goldsmithDiscountPercent: s.ded, makingPerGram: s.mk, cashDirection: s.dir, ...(s.dir !== 'none' ? { cashAmountEGP: s.amt } : {}),
    buyPrice: pBuy, sellPrice: pSell,
  });
  const c = checker();
  c.near('oldBefore', r.oldValueBeforeDiscountEGP, first(await text(page, 'rOld')), 0.006);
  if (s.ded > 0) {
    c.near('discount', r.discountEGP, first(await text(page, 'rDed')), 0.006);
    c.near('oldNet', r.oldValueEGP, first(await text(page, 'rOldNet')), 0.006);
  }
  c.near('newGold', r.newGoldValueEGP, first(await text(page, 'rNew')), 0.006);
  c.near('making', r.makingChargeEGP, first(await text(page, 'rMk')), 0.006);
  c.near('vat', r.vatOnMakingEGP, first(await text(page, 'rVat')), 0.006);
  c.near('newTotal', r.newTotalEGP, first(await text(page, 'rTotal')), 0.006);
  const hf = await text(page, 'hFair');
  c.near('|fair|', Math.abs(r.fairDifferenceEGP), first(hf), 0.006);
  c.eq('fair direction', r.fairDifferenceMeaning, hf.includes('تاخد') ? 'receive' : 'pay');
  const cls = (await page.$eval('#verdict', (e) => e.className)).replace('verdict', '').trim();
  c.eq('verdict', r.verdict, cls);
  const vt = await text(page, 'verdict');
  if (r.verdict !== 'generous') c.near('gap in message', Math.abs(r.gapEGP), nums(vt)[0], 0.5);
  record('gold-exchange-old-for-new', i, c.errs.length === 0, c.errs.join('; ') + ` [${r.verdict}]`);
  await page.close();
}

// ---------- proxies vs curl ----------
function curlJson(path, body) {
  const args = ['-s', '--max-time', '15', 'https://qintar.app/api/v1/' + path];
  if (body) args.push('-X', 'POST', '-H', 'content-type: application/json', '-d', JSON.stringify(body));
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8' })).data;
}
const strip = (o) => {
  const c = JSON.parse(JSON.stringify(o));
  for (const k of ['pricesAsOf', 'source', 'date', 'disclaimer', 'calculatedAt']) delete c[k];
  return c;
};
function sameJson(a, b) {
  const x = JSON.stringify(strip(a)), y = JSON.stringify(strip(b));
  return x === y ? '' : `differs\n run: ${x.slice(0, 400)}\n api: ${y.slice(0, 400)}`;
}
async function testProxy(calc, i, id, inputs, apiPath, apiBody) {
  const r = await gold.run(id, inputs);
  const direct = curlJson(apiPath, apiBody);
  const d = sameJson(r, direct);
  const meta = r.source === 'qintar.app' && typeof r.date === 'string' ? '' : ' missing source/date';
  record(calc, i, d === '' && meta === '', d + meta);
}

let fatal = null;
try {
  await testFair(1, { karat: 'K24', kind: 'BAR', w: 10, paid: 73500 });
  await testFair(2, { karat: 'K21', kind: 'MEDIUM_JEWELRY', w: 12.5, paid: 110000, mk: 120 });
  await testFair(3, { karat: 'K18', kind: 'SIMPLE_JEWELRY', w: 5, paid: 20000 });
  await testFair(4, { karat: 'K21', kind: 'SIMPLE_JEWELRY', w: 8, paid: 40000 });
  await testFair(5, { karat: 'K24', kind: 'COIN', w: 31.1, paid: 260000 });

  await testSell(1, { karat: 'K21', w: 16, paid: 110000, ded: 0 });
  await testSell(2, { karat: 'K18', w: 7.5, paid: 30000, ded: 5 });
  await testSell(3, { karat: 'K24', w: 20, paid: 120000, ded: 10 });

  await testUnit(1, { unit: 'pound', amount: 2.5 });
  await testUnit(2, { unit: 'ounce', amount: 3, karat: 'K24' });
  await testUnit(3, { unit: 'tola', amount: 10, karat: 'K18' });
  await testUnit(4, { unit: 'kilogram', amount: 0.75, karat: 'K21' });

  await testBudget(1, { karat: 'K21', kind: 'SIMPLE_JEWELRY', budget: 50000 });
  await testBudget(2, { karat: 'K24', kind: 'BAR', budget: 300000 });
  await testBudget(3, { karat: 'K18', kind: 'COMPLEX_JEWELRY', budget: 25000 });

  await testCompare(1, { karat: 'K21', kind: 'SIMPLE_JEWELRY', amount: 100000, years: 3, g: 25, c: 22, u: 10 }); // default making charge
  await testCompare(2, { karat: 'K24', kind: 'BAR', amount: 500000, years: 5, g: 15, c: 18, u: 8, spread: 2, mk: 85 });
  await testCompare(3, { karat: 'K18', kind: 'MEDIUM_JEWELRY', amount: 40000, years: 2, g: -5, c: 25, u: 0 });

  await testExchange(1, { oldK: '21', newK: '21', oldW: 20, newW: 20, ded: 0, mk: 100, dir: 'paid', amt: 5000 });
  await testExchange(2, { oldK: '18', newK: '21', oldW: 30, newW: 15, ded: 5, mk: 150, dir: 'received', amt: 20000 });
  await testExchange(3, { oldK: '21', newK: '24', oldW: 10, newW: 8, ded: 3, mk: 60, dir: 'none' });
  await testExchange(4, { oldK: '24', newK: '18', oldW: 12, newW: 20, ded: 0, mk: 80, dir: 'received', amt: 1000 });
} catch (e) {
  fatal = e;
  console.log('FATAL page test error:', e && e.stack || e);
} finally {
  await browser.close();
}

// proxies
try {
  await testProxy('gold-zakat', 1, 'gold-zakat',
    { holdings: [{ metalType: 'GOLD', karat: 'K21', weightGrams: 100 }, { metalType: 'SILVER', weightGrams: 700 }], cashEGP: 1000 },
    'calculators/zakat', { holdings: [{ metalType: 'GOLD', karat: 'K21', weightGrams: 100 }, { metalType: 'SILVER', weightGrams: 700 }], cashEGP: 1000 });
  await testProxy('gold-zakat', 2, 'gold-zakat',
    { holdings: [{ metalType: 'GOLD', karat: 'K24', weightGrams: 40 }, { metalType: 'GOLD', karat: 'K18', weightGrams: 30 }], cashEGP: 300000, cashItems: [{ currency: 'USD', amount: 2000 }] },
    'calculators/zakat', { holdings: [{ metalType: 'GOLD', karat: 'K24', weightGrams: 40 }, { metalType: 'GOLD', karat: 'K18', weightGrams: 30 }], cashEGP: 300000, cashItems: [{ currency: 'USD', amount: 2000 }] });
  await testProxy('gold-nisab', 1, 'gold-nisab', {}, 'calculators/zakat/nisab');
  await testProxy('gold-nisab', 2, 'gold-nisab', undefined, 'calculators/zakat/nisab');
  await testProxy('gold-making-charge', 1, 'gold-making-charge', { karat: 'K21', itemType: 'MEDIUM_JEWELRY', weightGrams: 12.5 },
    'calculators/craftsmanship', { karat: 'K21', itemType: 'MEDIUM_JEWELRY', weightGrams: 12.5 });
  await testProxy('gold-making-charge', 2, 'gold-making-charge', { karat: 'K24', itemType: 'BAR', weightGrams: 50, craftsmanshipPerGram: 70 },
    'calculators/craftsmanship', { karat: 'K24', itemType: 'BAR', weightGrams: 50, craftsmanshipPerGram: 70 });
  await testProxy('gold-bullion-prices', 1, 'gold-bullion-prices', {}, 'calculators/bullion');
  await testProxy('gold-bullion-prices', 2, 'gold-bullion-prices', {}, 'calculators/bullion');
} catch (e) {
  fatal = fatal || e;
  console.log('FATAL proxy test error:', e && e.stack || e);
}

// validation errors
const bad = [
  ['gold-fair-price-check', { karat: 'K21', kind: 'BAR', weightGrams: 5, paidEGP: 1000 }, /kind/],
  ['gold-fair-price-check', { karat: 'K99', kind: 'BAR', weightGrams: 5, paidEGP: 1000 }, /karat/],
  ['gold-sell-now', { karat: 'K21', weightGrams: -1, paidEGP: 1000 }, /weightGrams/],
  ['gold-sell-now', { karat: 'K21', weightGrams: 5, paidEGP: 1000, deductionPercent: 80 }, /deductionPercent/],
  ['gold-unit-convert', { unit: 'stone', amount: 1 }, /unit/],
  ['gold-budget', { budgetEGP: 'abc', karat: 'K21', kind: 'SIMPLE_JEWELRY' }, /budgetEGP/],
  ['gold-compare-investments', { amountEGP: 1000, years: 20 }, /years/],
  ['gold-exchange-old-for-new', { oldWeightGrams: 5, oldKarat: 'K21', newWeightGrams: 5, newKarat: 'K21', cashDirection: 'paid' }, /cashAmountEGP/],
  ['gold-making-charge', { karat: 'K24', itemType: 'SIMPLE_JEWELRY', weightGrams: 5 }, /itemType/],
  ['gold-zakat', { holdings: [{ metalType: 'GOLD', weightGrams: 5 }] }, /karat/],
  ['gold-zakat', {}, /holdings/],
];
let bi = 0;
for (const [id, inp, re] of bad) {
  bi++;
  try { await gold.run(id, inp); record('validation', bi, false, `${id} did not throw`); }
  catch (e) { record('validation', bi, re.test(e.message), `${id}: "${e.message}" !~ ${re}`); }
}

console.log('\nSUMMARY');
const by = {};
for (const r of results) { by[r.calc] ??= { pass: 0, fail: 0 }; by[r.calc][r.ok ? 'pass' : 'fail']++; }
for (const [k, v] of Object.entries(by)) console.log(`${k}: ${v.pass} passed, ${v.fail} failed (${v.pass + v.fail} input sets)`);
const failed = results.filter((r) => !r.ok).length;
process.exit(failed || fatal ? 1 : 0);
