// MCP Apps view ("interactive connector"): one self-contained HTML page the host renders in a
// sandboxed iframe next to the conversation. It speaks the MCP Apps postMessage protocol
// (ui/initialize, ui/notifications/tool-result, tools/call, ui/open-link) directly, so it needs no
// bundler and no external script (the default CSP of the extension is enough: connect-src 'none').
//
// What it shows, from the tool result's structuredContent:
//   calculators  -> a card per calculator with a form built from its input schema and a Run button
//                   (the button calls run_calculator through the host)
//   templates    -> a table of Excel templates; opening a link asks the user to confirm first
//   anything else-> a readable key/value tree
// Nothing is stored. The view never receives more than the tool already returned to the model.
const UI_URI = 'ui://softwiro/result';
const MIME = 'text/html;profile=mcp-app';

const HTML = `<!doctype html>
<html lang="ar" dir="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Softwiro</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1e293b;--mut:#64748b;--line:#e2e8f0;--acc:#4f46e5;--soft:#eef2ff;--card:#f8fafc}
@media(prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e2e8f0;--mut:#94a3b8;--line:#334155;--acc:#818cf8;--soft:#1e1b4b;--card:#111c33}}
*{box-sizing:border-box}body{margin:0;padding:12px;background:var(--bg);color:var(--fg);font:14px/1.7 system-ui,"Segoe UI",Tahoma,sans-serif}
h2{margin:0 0 8px;font-size:16px}.mut{color:var(--mut)}
.card{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:10px 12px;margin:0 0 10px}
.card h3{margin:0;font-size:14px}.card p{margin:2px 0 6px;color:var(--mut);font-size:12.5px}
label{display:block;font-size:12.5px;margin:6px 0 2px}
input,select,textarea{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer;margin-top:8px}
button.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}button:disabled{opacity:.5}
table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border-bottom:1px solid var(--line);padding:5px 6px;text-align:start;vertical-align:top}th{background:var(--soft)}
.kv td:first-child{color:var(--mut);width:38%}.err{color:#dc2626;margin-top:6px}
.dlg{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px}
.dlg div{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:14px;max-width:420px;width:100%;word-break:break-all}
</style></head><body><div id="root"><p class="mut">...</p></div>
<script>
(function () {
  var root = document.getElementById('root'), nid = 0, pending = {}, hostReady = false;
  function post(m) { window.parent.postMessage(m, '*'); }
  function request(method, params) {
    return new Promise(function (res, rej) { var id = ++nid; pending[id] = { res: res, rej: rej }; post({ jsonrpc: '2.0', id: id, method: method, params: params }); });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params }); }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data; if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && !m.method) { var p = pending[m.id]; if (p) { delete pending[m.id]; m.error ? p.rej(new Error(m.error.message || 'error')) : p.res(m.result); } return; }
    if (m.method === 'ui/notifications/tool-result') render(m.params || {});
    if (m.method === 'ui/resource-teardown' && m.id !== undefined) post({ jsonrpc: '2.0', id: m.id, result: {} });
  });
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { k === 'text' ? (n.textContent = attrs[k]) : n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function fmt(v) { return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
  function tree(obj) {
    if (obj === null || typeof obj !== 'object') return el('span', { text: fmt(obj) });
    if (Array.isArray(obj) && obj.length && obj.every(function (r) { return r && typeof r === 'object' && !Array.isArray(r); })) {
      var cols = []; obj.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0 && typeof r[k] !== 'object') cols.push(k); }); });
      var t = el('table'); t.appendChild(el('thead', {}, [el('tr', {}, cols.map(function (c) { return el('th', { text: c }); }))]));
      var b = el('tbody'); obj.slice(0, 200).forEach(function (r) { b.appendChild(el('tr', {}, cols.map(function (c) { return el('td', { text: fmt(r[c]) }); }))); }); t.appendChild(b); return t;
    }
    var kv = el('table', { class: 'kv' }), body = el('tbody');
    Object.keys(obj).forEach(function (k) { var v = obj[k]; body.appendChild(el('tr', {}, [el('td', { text: k }), el('td', {}, [typeof v === 'object' && v !== null ? tree(v) : el('span', { text: fmt(v) })])])); });
    kv.appendChild(body); return kv;
  }
  function confirmOpen(url) {
    var d = el('div', { class: 'dlg' }, [el('div', {}, [
      el('p', { text: 'Open this link outside Claude? / فتح الرابط خارج Claude؟' }), el('p', { class: 'mut', text: url }),
      el('button', { text: 'OK' }), el('button', { class: 'ghost', text: 'Cancel' })])]);
    var bs = d.querySelectorAll('button');
    bs[0].onclick = function () { d.remove(); request('ui/open-link', { url: url }).catch(function () {}); };
    bs[1].onclick = function () { d.remove(); };
    document.body.appendChild(d);
  }
  function runForm(c) {
    var card = el('div', { class: 'card' }, [el('h3', { text: c.title || c.id }), el('p', { text: c.description || '' })]);
    var fields = {}, ins = c.inputs || {};
    Object.keys(ins).forEach(function (k) {
      var s = ins[k] || {}, f;
      if (s.enum) { f = el('select'); s.enum.forEach(function (o) { var op = el('option', { value: o, text: o }); if (o === s.default) op.selected = true; f.appendChild(op); }); }
      else if (s.type === 'boolean') { f = el('select'); ['false', 'true'].forEach(function (o) { f.appendChild(el('option', { value: o, text: o })); }); }
      else if (s.type === 'number' || s.type === 'integer') { f = el('input', { type: 'number', step: 'any' }); if (s.default !== undefined) f.value = s.default; }
      else if (s.type === 'array' || s.type === 'object') { f = el('textarea', { rows: '3', placeholder: 'JSON' }); }
      else { f = el('input', { type: 'text' }); if (s.default !== undefined) f.value = s.default; }
      fields[k] = { f: f, t: s.type };
      card.appendChild(el('label', { text: k + (s.description ? ' — ' + String(s.description).slice(0, 90) : '') })); card.appendChild(f);
    });
    var out = el('div'), btn = el('button', { text: 'Run / تشغيل' });
    btn.onclick = function () {
      var args = {};
      try {
        Object.keys(fields).forEach(function (k) {
          var v = fields[k].f.value; if (v === '') return;
          if (fields[k].t === 'number' || fields[k].t === 'integer') args[k] = Number(v);
          else if (fields[k].t === 'boolean') args[k] = v === 'true';
          else if (fields[k].t === 'array' || fields[k].t === 'object') args[k] = JSON.parse(v);
          else args[k] = v;
        });
      } catch (e) { out.replaceChildren(el('p', { class: 'err', text: 'JSON: ' + e.message })); return; }
      btn.disabled = true;
      request('tools/call', { name: 'run_calculator', arguments: { id: c.id, inputs: args } }).then(function (r) {
        var sc = r && r.structuredContent, txt = r && r.content && r.content[0] && r.content[0].text;
        if (r && r.isError) out.replaceChildren(el('p', { class: 'err', text: txt || 'error' }));
        else out.replaceChildren(tree(sc && sc.result !== undefined ? sc.result : sc || txt));
      }).catch(function (e) { out.replaceChildren(el('p', { class: 'err', text: e.message })); }).then(function () { btn.disabled = false; size(); });
    };
    card.appendChild(btn); card.appendChild(out); return card;
  }
  function templates(items) {
    var t = el('table'); t.appendChild(el('thead', {}, [el('tr', {}, ['', 'id', ''].map(function (x, i) { return el('th', { text: i === 0 ? 'Template' : i === 1 ? 'id' : 'Links' }); }))]));
    var b = el('tbody');
    items.slice(0, 80).forEach(function (x) {
      var links = el('td');
      [['xlsx', x.download], ['online', x.page]].forEach(function (p) { if (p[1]) { var bt = el('button', { class: 'ghost', text: p[0] }); bt.onclick = function () { confirmOpen(p[1]); }; links.appendChild(bt); links.appendChild(document.createTextNode(' ')); } });
      b.appendChild(el('tr', {}, [el('td', { text: x.title || x.id }), el('td', { text: x.id }), links]));
    });
    t.appendChild(b); return t;
  }
  function render(res) {
    var sc = res.structuredContent, nodes = [];
    if (res.isError) nodes.push(el('p', { class: 'err', text: res.content && res.content[0] ? res.content[0].text : 'error' }));
    else if (sc && Array.isArray(sc.calculators)) { nodes.push(el('h2', { text: sc.count + ' calculators' })); sc.calculators.slice(0, 40).forEach(function (c) { nodes.push(runForm(c)); }); }
    else if (sc && Array.isArray(sc.items) && sc.items[0] && sc.items[0].page) { nodes.push(el('h2', { text: sc.items.length + ' templates' })); nodes.push(templates(sc.items)); }
    else if (sc) nodes.push(tree(sc.result !== undefined ? sc.result : sc));
    else nodes.push(el('p', { class: 'mut', text: res.content && res.content[0] ? res.content[0].text : '' }));
    root.replaceChildren.apply(root, nodes); size();
  }
  function size() { notify('ui/notifications/size-changed', { width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) }); }
  if (window.ResizeObserver) new ResizeObserver(size).observe(document.body);
  request('ui/initialize', { appInfo: { name: 'Softwiro', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
    .then(function () { hostReady = true; notify('ui/notifications/initialized', {}); size(); }).catch(function () {});
})();
</script></body></html>`;

module.exports = { UI_URI, MIME, HTML };
