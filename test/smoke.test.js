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

    // MCP Apps: result tools point at the ui:// view, the view is served as an MCP App, results carry structuredContent
    const ui = (await rpc('tools/list')).result.tools;
    for (const n of ['list_templates', 'calculate', 'list_calculators', 'run_calculator']) {
      const t = ui.find(x => x.name === n);
      assert.strictEqual(t._meta.ui.resourceUri, 'ui://softwiro/result', n + ' should open the view');
    }
    assert.ok(!ui.find(x => x.name === 'get_schema')._meta, 'get_schema stays text-only');
    const rd = (await rpc('resources/read', { uri: 'ui://softwiro/result' })).result.contents[0];
    assert.strictEqual(rd.mimeType, 'text/html;profile=mcp-app');
    assert.ok(rd.text.includes('ui/initialize') && !/<script[^>]+src=/.test(rd.text), 'view is self-contained');
    assert.ok((await rpc('resources/read', { uri: 'ui://other' })).error, 'unknown resource is an error');
    const sc = (await rpc('tools/call', { name: 'list_templates', arguments: { query: 'gym' } })).result;
    assert.ok(Array.isArray(sc.structuredContent.items) && sc.structuredContent.items[0].page, 'structuredContent wraps arrays');
    assert.ok(JSON.parse(sc.content[0].text).length, 'text content unchanged');

    // A2UI 1.0: surfaces, events, validation and the confirm step for sensitive actions
    const a2ui = require('../src/a2ui');
    const events = async body => { const r = await fetch(base + '/api/a2ui/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return (await r.text()).split('\n\n').filter(Boolean).map(l => JSON.parse(l.replace(/^data: /, ''))); };
    const surf = (await (await fetch(base + '/api/a2ui/surface/calculator/vat-calculator')).text()).split('\n\n').filter(Boolean).map(l => JSON.parse(l.slice(6)));
    assert.strictEqual(surf[0].version, '1.0');
    assert.strictEqual(Object.keys(surf[0]).filter(k => k !== 'version').length, 1, 'one operation per message');
    assert.ok(surf[0].createSurface.components.some(c => c.id === 'root'), 'surface has a root');
    const act = (name, context, surfaceId) => ({ message: { version: '1.0', action: { name, surfaceId: surfaceId || 'calc-vat-calculator', context } } });
    const ran = await events(act('run_calculator', { id: 'vat-calculator', inputs: { country: ['eg'], mode: ['add'], lines: '[{"price":1000,"quantity":2}]' } }));
    assert.ok(ran.some(m => m.updateDataModel && m.updateDataModel.path === '/result' && /2280/.test(m.updateDataModel.value)), 'action ran the calculator');
    assert.ok((await events({ message: { version: '2.0', action: {} } }))[0].error, 'wrong version is rejected');
    assert.ok((await events(act('nope', {})))[0].error, 'unknown action is rejected');
    assert.ok((await events(act('run_calculator', { id: '../x' })))[0].error, 'bad id is rejected');
    // a sensitive action asks first, runs only with the server's token, and the token is bound to the context
    let did = 0;
    a2ui.registerAction('test_sensitive', { sensitive: true, question: 'Sure?', async handler() { did++; return []; } });
    const first = await events(act('test_sensitive', { item: 1 }, 'cart'));
    assert.strictEqual(did, 0, 'not run before confirmation');
    const tok = first[0].createSurface.components.find(c => c.id === 'yes').action.event.context.confirmToken;
    assert.ok(tok, 'confirm card carries a token');
    assert.ok((await events(act('test_sensitive', { item: 2, confirmToken: tok }, 'cart')))[0].error, 'token for another context is refused');
    assert.ok((await events(act('test_sensitive', { item: 1, confirmToken: 'x.y' }, 'cart')))[0].error, 'forged token is refused');
    await events(act('test_sensitive', { item: 1, confirmToken: tok }, 'cart'));
    assert.strictEqual(did, 1, 'ran once after confirmation');
    const toolRes = (await rpc('tools/call', { name: 'run_calculator', arguments: { id: 'vat-calculator', inputs: { lines: [{ price: 100 }] } } })).result;
    assert.ok(toolRes.structuredContent.a2ui[0].createSurface, 'tool result carries A2UI next to the data');

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
