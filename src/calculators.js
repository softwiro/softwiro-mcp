// One registry for the free calculators exposed over MCP and REST:
// the softwiro.com tools (tools-softwiro.js) and the Qintar gold calculators (tools-gold.js).
const groups = [];
for (const [file, group] of [['./tools-softwiro', 'softwiro'], ['./tools-gold', 'qintar-gold']]) {
  try { const m = require(file); groups.push({ group, list: m.list || [], run: m.run }); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
}

function all() {
  return groups.flatMap(g => g.list.map(c => ({ ...c, group: g.group })));
}

function catalog(query) {
  const q = String(query || '').trim().toLowerCase();
  return all()
    .filter(c => !q || [c.id, c.title, c.description, c.group].join(' ').toLowerCase().includes(q))
    .map(c => ({ id: c.id, title: c.title, group: c.group, description: c.description, inputs: c.inputs, output: c.output }));
}

async function run(id, inputs) {
  for (const g of groups) {
    if (g.list.some(c => c.id === id)) {
      if (inputs !== undefined && (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs))) throw new Error('inputs must be an object');
      return g.run(id, inputs || {});
    }
  }
  throw Object.assign(new Error('unknown calculator id; call list_calculators'), { code: 404 });
}

module.exports = { catalog, run, count: () => all().length };
