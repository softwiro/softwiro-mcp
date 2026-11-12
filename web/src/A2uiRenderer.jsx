// React renderer for the A2UI 1.0 basic catalog (the subset Softwiro uses plus a few extras).
// Drawing only: no HTML is injected, links open only through the openUrl function after a user click,
// and a component type that is not in this catalog renders a visible placeholder instead of running anything.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { resolve, getPointer } from './processor.js';

const safeUrl = u => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; } };

// Markdown subset for Text: **bold** and "- " list lines. Built as React nodes, never as HTML.
function Md({ src }) {
  const lines = String(src ?? '').split('\n');
  const inline = t => t.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
  const out = []; let list = [];
  const flush = () => { if (list.length) { out.push(<ul key={'u' + out.length}>{list}</ul>); list = []; } };
  lines.forEach((l, i) => { if (l.startsWith('- ')) list.push(<li key={i}>{inline(l.slice(2))}</li>); else { flush(); if (l.trim()) out.push(<p key={i}>{inline(l)}</p>); } });
  flush();
  return <>{out}</>;
}

export function Surface({ surface, ctx }) {
  useSyncExternalStore(ctx.processor.subscribe.bind(ctx.processor), () => surface.v);
  const root = surface.components.get('root');
  if (!root) return null;
  return <div className="a2-surface" data-surface={surface.id}><Node id="root" surface={surface} ctx={ctx} /></div>;
}

function Node({ id, surface, ctx, scope }) {
  const c = surface.components.get(id);
  const [open, setOpen] = useState(false);
  if (!c) return <span className="a2-missing">[{id}]</span>;
  const r = v => resolve(v, surface.model, scope);
  const kids = list => (Array.isArray(list) ? list : []).map(k => <Node key={k} id={k} surface={surface} ctx={ctx} scope={scope} />);
  const justify = { start: 'flex-start', center: 'center', end: 'flex-end', spaceBetween: 'space-between', spaceAround: 'space-around', spaceEvenly: 'space-evenly', stretch: 'stretch' };
  const align = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
  const flex = (dir) => ({ display: 'flex', flexDirection: dir, justifyContent: justify[c.justify] || 'flex-start', alignItems: align[c.align] || 'stretch', gap: 8, flexWrap: dir === 'row' ? 'wrap' : 'nowrap' });
  const write = (path, v) => ctx.processor.process({ version: '1.0', updateDataModel: { surfaceId: surface.id, path: String(path['@path']), value: v } });
  const bindable = v => v && typeof v === 'object' && '@path' in v;

  switch (c.component) {
    case 'Text': { const t = r(c.text); return <div className={'a2-text ' + (c.variant || 'body')}><Md src={t} /></div>; }
    case 'Column': return <div style={flex('column')}>{kids(c.children)}</div>;
    case 'Row': return <div style={flex('row')}>{kids(c.children)}</div>;
    case 'List': return <div style={flex(c.direction === 'horizontal' ? 'row' : 'column')}>{kids(c.children)}</div>;
    case 'Card': return <div className="a2-card"><Node id={c.child} surface={surface} ctx={ctx} scope={scope} /></div>;
    case 'Divider': return <hr className="a2-divider" />;
    case 'Image': { const u = safeUrl(r(c.url)); return u ? <img className="a2-img" src={u} alt={r(c.description) || ''} /> : null; }
    case 'Button': {
      const click = () => {
        const a = c.action || {};
        if (a.event) ctx.sendAction({ name: a.event.name, surfaceId: surface.id, sourceComponentId: c.id, timestamp: new Date().toISOString(), context: r(a.event.context || {}) });
        else if (a.functionCall && a.functionCall['@call'] === 'openUrl') { const u = safeUrl(r(a.functionCall.args && a.functionCall.args.url)); if (u) window.open(u, '_blank', 'noopener,noreferrer'); }
      };
      return <button className={'a2-btn ' + (c.variant || 'default')} onClick={click}><Node id={c.child} surface={surface} ctx={ctx} scope={scope} /></button>;
    }
    case 'TextField': {
      const v = r(c.value) ?? '';
      const common = { value: v, placeholder: c.placeholder || '', onChange: e => bindable(c.value) && write(c.value, e.target.value) };
      return <label className="a2-field"><span>{r(c.label)}</span>{c.variant === 'longText' ? <textarea rows={3} {...common} /> : <input {...common} type={c.variant === 'number' ? 'number' : c.variant === 'obscured' ? 'password' : 'text'} step="any" />}</label>;
    }
    case 'CheckBox': return <label className="a2-check"><input type="checkbox" checked={!!r(c.value)} onChange={e => bindable(c.value) && write(c.value, e.target.checked)} /> <span>{r(c.label)}</span></label>;
    case 'ChoicePicker': {
      const sel = Array.isArray(r(c.value)) ? r(c.value) : [];
      const multi = c.variant === 'multipleSelection';
      const pick = val => bindable(c.value) && write(c.value, multi ? (sel.includes(val) ? sel.filter(x => x !== val) : [...sel, val]) : [val]);
      return <div className="a2-field"><span>{r(c.label)}</span><div className="a2-chips">{(c.options || []).map(o => <button type="button" key={o.value} className={'a2-chip' + (sel.includes(o.value) ? ' on' : '')} onClick={() => pick(o.value)}>{r(o.label)}</button>)}</div></div>;
    }
    case 'Modal': return <>
      <span onClickCapture={e => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}><Node id={c.trigger} surface={surface} ctx={ctx} scope={scope} /></span>
      {open && <div className="a2-dlg" onClick={() => setOpen(false)}><div className="a2-dlg-box" onClick={e => { e.stopPropagation(); if (e.target.closest('button')) setTimeout(() => setOpen(false), 0); }}><Node id={c.content} surface={surface} ctx={ctx} scope={scope} /></div></div>}
    </>;
    default: return <span className="a2-missing" title="not in the basic catalog">[{c.component}]</span>;
  }
}
