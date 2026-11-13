// Softwiro A2UI demo client: loads A2UI surfaces from /api/a2ui (SSE), renders them, and sends the
// user's actions back. The renderer itself (processor.js + A2uiRenderer.jsx) does not depend on Softwiro.
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Processor } from './processor.js';
import { Surface } from './A2uiRenderer.jsx';
import { EMBEDDED, createBridge, messagesOf } from './mcpBridge.js';
import './style.css';

const BASE = (document.querySelector('meta[name=a2ui-base]') || {}).content || '/api/a2ui';

// Interface language: ?lang=ar|en, then the last choice, then the browser language
const TX = {
  en: { title: 'Softwiro · A2UI 1.0', intro: 'Pick a calculator or the templates list. The server sends A2UI messages; this page draws them and sends your clicks back.', calcs: 'Calculators…', tpl: 'Templates (gym)', other: 'العربية', note: '' },
  ar: { title: 'Softwiro · A2UI 1.0', intro: 'اختر حاسبة أو قائمة القوالب. يرسل الخادم رسائل A2UI، وترسمها هذه الصفحة وتعيد إليه ضغطاتك.', calcs: 'الحاسبات…', tpl: 'القوالب (الجيم)', other: 'English', note: '' },
};
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'ar' || q === 'en') return q;
  try { const s = localStorage.getItem('a2ui-lang'); if (s === 'ar' || s === 'en') return s; } catch (e) { /* storage may be blocked */ }
  return (navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

// Reads a Server-Sent Events response and hands each JSON message to onMessage as it arrives (streaming UI)
async function readSse(res, onMessage) {
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (data) { try { onMessage(JSON.parse(data)); } catch (e) { /* skip a malformed event */ } }
    }
  }
}

function App() {
  const processor = useMemo(() => new Processor(), []);
  const [calcs, setCalcs] = useState([]);
  const [busy, setBusy] = useState('');
  const [lang, setLang] = useState(pickLang);
  const T = TX[lang];
  useEffect(() => { document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; try { localStorage.setItem('a2ui-lang', lang); } catch (e) { /* ignore */ } }, [lang]);
  useSyncExternalStore(processor.subscribe.bind(processor), () => processor.surfaces.size + ':' + processor.errors.length);
  useEffect(() => { fetch('/api/a2ui/calculators?lang=' + lang).then(r => r.json()).then(d => setCalcs(d.calculators || [])).catch(() => {}); }, [lang]);

  const open = async (path, replaceId) => {
    setBusy('...');
    try {
      processor.surfaces.clear();
      await readSse(await fetch(BASE + path + (path.includes('?') ? '&' : '?') + 'lang=' + lang), m => processor.process(m));
    } catch (e) { processor.error('EXECUTION_ERROR', String(e.message)); processor.emit(); }
    setBusy('');
  };
  const bridge = useMemo(() => EMBEDDED ? createBridge({ onToolResult: r => { const ms = messagesOf(r); if (!ms.length) return; processor.surfaces.clear(); const ar = /[\u0600-\u06FF]/.test(JSON.stringify(ms)); document.documentElement.dir = ar ? 'rtl' : 'ltr'; document.documentElement.lang = ar ? 'ar' : 'en'; ms.forEach(m => processor.process(m)); } }) : null, [processor]);
  const ctx = useMemo(() => ({
    processor,
    openUrl: bridge ? (u => bridge.openLink(u).catch(() => {})) : null,
    sendAction: async action => {
      if (bridge) {
        const sid = action.surfaceId;
        processor.process({ version: '1.0', updateDataModel: { surfaceId: sid, path: '/status', value: '...' } });
        try {
          const r = await bridge.callTool('a2ui_action', { name: action.name, surfaceId: sid, context: action.context, lang: (action.context && action.context.lang) || undefined });
          messagesOf(r).forEach(m => processor.process(m));
        } catch (e) { processor.process({ version: '1.0', updateDataModel: { surfaceId: sid, path: '/status', value: String(e.message) } }); }
        return;
      }
      const sid = action.surfaceId;
      processor.process({ version: '1.0', updateDataModel: { surfaceId: sid, path: '/status', value: '...' } });
      try {
        const res = await fetch(BASE + '/events?lang=' + lang, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { version: '1.0', action } }) });
        await readSse(res, m => processor.process(m));
      } catch (e) { processor.process({ version: '1.0', updateDataModel: { surfaceId: sid, path: '/status', value: String(e.message) } }); }
    },
  }), [processor, lang, bridge]);

  if (EMBEDDED) return <div className="a2-app a2-embedded">
    {Array.from(processor.surfaces.values()).map(s => <Surface key={s.id} surface={s} ctx={ctx} />)}
    {processor.errors.length > 0 && <pre className="a2-errors">{processor.errors.slice(-3).map(e => e.code + ': ' + e.message).join('\n')}</pre>}
  </div>;

  return <div className="a2-app">
    <h1>{T.title}</h1>
    <p className="mut">{T.intro}</p>
    <p className="mut small">{T.note}</p>
    <div className="a2-bar">
      <select defaultValue="" onChange={e => e.target.value && open('/surface/calculator/' + e.target.value)}>
        <option value="" disabled>{T.calcs}</option>
        {calcs.map(c => <option key={c.id} value={c.id}>{c.title || c.id}</option>)}
      </select>
      <button className="a2-btn primary" onClick={() => open('/surface/templates?q=gym')}>{T.tpl}</button>
      <button className="a2-btn" onClick={() => { processor.surfaces.clear(); processor.emit(); setLang(lang === 'ar' ? 'en' : 'ar'); }}>{T.other}</button>
      <span className="mut">{busy}</span>
    </div>
    {Array.from(processor.surfaces.values()).map(s => <Surface key={s.id} surface={s} ctx={ctx} />)}
    {processor.errors.length > 0 && <pre className="a2-errors">{processor.errors.slice(-3).map(e => e.code + ': ' + e.message).join('\n')}</pre>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
