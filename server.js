// Standalone server: node server.js  (PORT, HOST, TRUST_PROXY, USAGE_FILE are optional environment variables)
const express = require('express');
const { configure, mount } = require('./src/index');

configure({ usageFile: process.env.USAGE_FILE || null, siteBase: process.env.SITE_BASE || 'https://softwiro.com' });
const app = express();
// Behind a reverse proxy set TRUST_PROXY=1 so the rate limits see the real client address
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
mount(app, express);
app.get('/health', (req, res) => res.json({ ok: true }));
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`softwiro-mcp listening on http://${host}:${port}/api/mcp`));
