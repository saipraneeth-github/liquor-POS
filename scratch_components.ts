import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

const selectorMatches = Array.from(code.matchAll(/selectors:\s*\[\[\s*["']([^"']+)["']\s*\]\]/g)).map(m => m[1]);
const uniqueSelectors = Array.from(new Set(selectorMatches));

console.log('Total unique Angular component selectors:', uniqueSelectors.length);
console.log('Selectors sample:', uniqueSelectors.slice(0, 50));

fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/component_selectors.json', JSON.stringify(uniqueSelectors, null, 2));

