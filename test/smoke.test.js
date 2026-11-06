// Offline smoke test: starts the server on a free port and checks the main paths. Gold calculators need the network and are not run here.
const http = require('http');
const assert = require('assert');
const express = require('express');
const { configure, mount } = require('../src/index');

configure();
const app = express();
mount(app, express);
const srv = http.createServer(app).listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(base + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-softwiro-test': '1' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return (await r.json());
  };
  const call = async (name, args) => {
    const o = await rpc('tools/call', { name, arguments: args });
    return { error: o.result.isError, data: o.result.isError ? o.result.content[0].text : JSON.parse(o.result.content[0].text) };
  };
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'smoke-test' } });
    assert.strictEqual(init.result.serverInfo.name, 'softwiro-templates');

    const tools = (await rpc('tools/list')).result.tools;
    assert.deepStrictEqual(tools.map(t => t.name), ['list_templates', 'get_schema', 'calculate', 'get_download', 'list_calculators', 'run_calculator']);
    for (const t of tools) assert.strictEqual(t.annotations.readOnlyHint, true, t.name + ' should be read-only');

    const list = await call('list_templates', {});
    assert.ok(list.data.length >= 60, 'catalog size ' + list.data.length);
    assert.ok((await call('list_templates', { query: 'gym' })).data.some(t => t.id === 'gym-memberships'));

    const schema = await call('get_schema', { id: 'gym-memberships' });
    assert.ok(schema.data.sheets.length > 3);
    assert.ok((await call('get_schema', { id: 'nope' })).error, 'unknown id must fail');

    const calc = await call('calculate', { id: 'gym-memberships', mode: 'replace', records: [{ sheet: 'الباقات', rows: [{ 'الباقة': 'شهري', 'السعر': 500, 'المدة (أشهر)': 1 }] }] });
    assert.ok(!calc.error && Array.isArray(calc.data.results) && calc.data.results.length > 0, 'calculate returned no results');

    const dl = await call('get_download', { id: 'gym-memberships' });
    assert.ok(dl.data.xlsx.endsWith('.xlsx'));

    const cals = await call('list_calculators', {});
    assert.strictEqual(cals.data.count, 23);

    const vat = await call('run_calculator', { id: 'vat-calculator', inputs: { country: 'eg', mode: 'add', lines: [{ price: 1000, quantity: 2 }, { price: 250 }] } });
    assert.deepStrictEqual([vat.data.net, vat.data.tax, vat.data.gross], [2250, 315, 2565]);

    const bmi = await call('run_calculator', { id: 'bmi-calculator', inputs: { units: 'metric', age: 30, height_cm: 175, weight_kg: 70 } });
    assert.strictEqual(bmi.data.bmi, 22.9);

    assert.ok((await call('run_calculator', { id: 'vat-calculator', inputs: { lines: [{ price: -5 }] } })).error, 'negative price must fail');
    assert.ok((await call('run_calculator', { id: 'nope' })).error, 'unknown calculator must fail');

    const rest = await (await fetch(base + '/api/v1/templates?q=gym')).json();
    assert.ok(rest.count >= 1);
    console.log('smoke test passed');
    srv.close(); process.exit(0);
  } catch (e) { console.error('FAILED:', e.message); srv.close(); process.exit(1); }
});
