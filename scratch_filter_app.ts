import * as fs from 'fs';

const selectors = JSON.parse(fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/component_selectors.json', 'utf8'));

const appComponents = selectors.filter((s: string) => s.startsWith('app-'));
console.log('App components total:', appComponents.length);
console.log(JSON.stringify(appComponents, null, 2));

fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/app_components.json', JSON.stringify(appComponents, null, 2));

