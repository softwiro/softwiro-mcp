# Softwiro MCP

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant **calculate inside 67 free Arabic Excel templates** and **run 23 quick calculators** (VAT, BMI, due date, gold zakat and more), instead of guessing the numbers. Results come from the templates' own formulas and the calculators' own code. Stateless, no API key, nothing stored.

- Hosted endpoint (free, no key): `https://softwiro.com/api/mcp` (Streamable HTTP)
- Overview, examples, terms and privacy: <https://softwiro.com/mcp> · Arabic: <https://softwiro.com/ar/mcp>
- Step-by-step guide with a worked example: <https://softwiro.com/blog/mcp-excel-templates-ai-agent-guide.html>
- Official MCP Registry name: `com.softwiro/templates`

Ask your assistant to use it explicitly ("use the softwiro MCP and do not calculate yourself"). Without that, an assistant may calculate in its head and never call the tool.

## Connect

These steps follow each app's own documentation; menus can differ by plan and version.

**Claude Code**

```
claude mcp add --transport http softwiro https://softwiro.com/api/mcp
```

**Claude (web / desktop):** Customize → Connectors → + Add → Add custom connector, name `softwiro`, URL above.

**ChatGPT:** Plugins → + → Add custom MCP server, name `softwiro`, URL above, authentication: *No authentication*. Custom MCP servers may need a plan or workspace setting that allows them.

**Cursor** (`.cursor/mcp.json`):

```json
{ "mcpServers": { "softwiro": { "url": "https://softwiro.com/api/mcp" } } }
```

Check it from a terminal:

```
curl -s https://softwiro.com/api/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tools

| Tool | What it does |
|---|---|
| `list_templates` | Search the catalog of free Excel templates (Arabic or English text). |
| `get_schema` | Tables, columns (input vs formula), settings and result cells of one template. Call before `calculate`. |
| `calculate` | Fills a template with your records and settings, recalculates with its own formulas, returns the results. Nothing is saved. |
| `get_download` | Links to the `.xlsx` file and the online version of a template. |
| `list_calculators` | Lists the 23 calculators and their input names. |
| `run_calculator` | Runs one calculator. |

All six are read-only and idempotent (templates that use `TODAY()` follow the server's date).

### Calculators

13 from Softwiro: VAT, BMI, calories, due date, ovulation, break-even, garment costing, fabric requirements, piece-rate pay, pharmacy margin, reorder point, no-show cost, study timetable.

10 gold calculators from [Qintar](https://qintar.app): zakat on gold, silver and cash, nisab, making charge, bar and pound prices, fair-price check, sell-now, unit conversion, budget, gold vs certificates vs dollar, swapping old gold for new. They fetch live prices from `qintar.app` and return an error if prices are unavailable. Results are indicative: the zakat and gold calculators are not a fatwa, and the health calculators are not medical advice.

## Example

```
Use the softwiro MCP (run_calculator with vat-calculator) and do not calculate anything yourself.
Egypt, add VAT to two items of 1,000 each and one item of 250.
```

Returns net 2,250, tax 315, total 2,565 (VAT 14%).

## Run it yourself

Node 18+.

```
npm install
npm start            # http://127.0.0.1:3000/api/mcp
npm test             # offline smoke test
```

Environment variables: `PORT`, `HOST`, `TRUST_PROXY` (set to `1` behind a reverse proxy so rate limits see the real client address), `USAGE_FILE` (JSON file for aggregate counters; omit to keep them in memory), `SITE_BASE` (base URL used in catalog links, default `https://softwiro.com`).

### As a library

```js
const express = require('express');
const { configure, mount } = require('./src/index');
configure({ dataDir: './data' });   // also: templatesDir, schemasDir, siteBase, usageFile, catalog()
const app = express(); mount(app, express);
```

### Layout

```
src/index.js          HTTP handlers, MCP JSON-RPC, limits, aggregate usage counters
src/worker.js         one calculation in an isolated worker thread (timeout kills it)
src/engine.js         the formula engine (fast-formula-parser with Excel-compatible tweaks)
src/tools-softwiro.js the 13 Softwiro calculators
src/tools-gold.js     the 10 Qintar gold calculators
data/catalog.json     template catalog      data/templates/   the .xlsx files
data/schemas/         one JSON schema per template      data/tool-text.json   Arabic page text of the calculators
```

### Limits

Request body 200 KB, at most 500 rows and 500 cells, 30 calculations and 120 reads per minute per client, 15 seconds per calculation, 2 calculations at once.

## Privacy

Request content is not stored or logged by this server. It keeps aggregate daily counters only (calls per tool, template or calculator, errors, and the connecting app's name such as `claude-code`): no IP addresses and no request bodies. The hosted service sits behind the softwiro.com web server, which keeps ordinary access logs for a short period (see <https://softwiro.com/privacy>). The zakat calculator sends the amounts you enter to Qintar's calculator service.

## Tests

`npm test` is an offline smoke test. `test/parity/gold.test.mjs` compares the gold calculators with the live Qintar pages in a headless browser (dev-only: needs `playwright-core` and a Chromium, or `CHROME_PATH`).

## License

Code: MIT, see `LICENSE`. The files in `data/templates/` are the same free Excel templates published at <https://softwiro.com/templates>: use, edit and share them freely.

---

# Softwiro MCP (بالعربي)

خادم MCP يخلّي مساعد الذكاء الاصطناعي يحسب داخل **67 قالب إكسل عربي مجاني** ويشغّل **23 حاسبة** (ضريبة القيمة المضافة، كتلة الجسم، موعد الولادة، زكاة الذهب وغيرها) بدل ما يخمّن الأرقام. النتائج من معادلات القوالب نفسها ومن كود الحاسبات. بلا مفتاح ولا حساب، ولا يخزّن شيئًا.

- الرابط المستضاف (مجاني): `https://softwiro.com/api/mcp`
- الشرح والأمثلة والشروط والخصوصية: <https://softwiro.com/ar/mcp>
- في Claude Code: `claude mcp add --transport http softwiro https://softwiro.com/api/mcp`
- ابدأ طلبك بـ «استخدم الـ MCP بتاع softwiro وماتحسبش بنفسك» عشان المساعد ينادي الأداة بدل ما يحسب في دماغه.

الأدوات الست: `list_templates` (بحث في القوالب)، `get_schema` (هيكل القالب)، `calculate` (الحساب في قالب)، `get_download` (روابط التحميل)، `list_calculators` و`run_calculator` (الحاسبات). النتائج استرشادية: حاسبات الزكاة والذهب ليست فتوى، والحاسبات الصحية ليست نصيحة طبية.

التشغيل محليًا: `npm install` ثم `npm start`.
