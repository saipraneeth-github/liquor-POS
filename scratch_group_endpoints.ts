import * as fs from 'fs';

const endpoints = JSON.parse(fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/endpoints.json', 'utf8'));

const grouped: Record<string, any[]> = {};
for (const ep of endpoints) {
  // path is /lctg/api/<module>/...
  const parts = ep.path.replace('/lctg/api/', '').split('/');
  const mod = parts[0] || 'root';
  if (!grouped[mod]) grouped[mod] = [];
  grouped[mod].push(ep);
}

const summary = Object.entries(grouped).map(([mod, list]) => ({
  module: mod,
  count: list.length,
  endpoints: list.map(l => ({ name: l.propName, path: l.path })),
}));

fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/endpoints_grouped.json', JSON.stringify(summary, null, 2));
console.log('Modules found:', summary.map(s => `${s.module} (${s.count})`));

