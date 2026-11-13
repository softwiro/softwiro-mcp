// MCP Apps bridge (A2UI inside an MCP App): when this page runs in a host's sandboxed iframe it speaks the
// postMessage JSON-RPC protocol (ui/initialize, ui/notifications/tool-result, tools/call, ui/open-link).
// A2UI messages arrive as embedded resources of type application/a2ui+json in tool results.
export const EMBEDDED = (() => { try { return window.parent !== window; } catch (e) { return true; } })();

const A2UI_MIMES = ['application/a2ui+json', 'application/json+a2ui'];

// All A2UI messages found in a CallToolResult
export function messagesOf(result) {
  const out = [];
  ((result && result.content) || []).forEach(c => {
    const r = c && c.type === 'resource' && c.resource;
    if (r && A2UI_MIMES.includes(r.mimeType) && typeof r.text === 'string') {
      try { const v = JSON.parse(r.text); (Array.isArray(v) ? v : [v]).forEach(m => m && out.push(m)); } catch (e) { /* skip a malformed resource */ }
    }
  });
  return out;
}

export function createBridge({ onToolResult }) {
  let nid = 0; const pending = new Map();
  const post = m => window.parent.postMessage(m, '*');
  const request = (method, params) => new Promise((res, rej) => { const id = ++nid; pending.set(id, { res, rej }); post({ jsonrpc: '2.0', id, method, params }); });
  const notify = (method, params) => post({ jsonrpc: '2.0', method, params });
  window.addEventListener('message', e => {
    const m = e.data; if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message || 'error')) : p.res(m.result); return; }
    if (m.method === 'ui/notifications/tool-result') onToolResult(m.params || {});
    if (m.method === 'ui/resource-teardown' && m.id !== undefined) post({ jsonrpc: '2.0', id: m.id, result: {} });
  });
  request('ui/initialize', { appInfo: { name: 'Softwiro A2UI', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
    .then(() => notify('ui/notifications/initialized', {})).catch(() => {});
  const size = () => notify('ui/notifications/size-changed', { width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(size).observe(document.documentElement);
  return {
    callTool: (name, args) => request('tools/call', { name, arguments: args }),
    openLink: url => request('ui/open-link', { url }),
  };
}
