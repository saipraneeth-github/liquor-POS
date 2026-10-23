import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

const headerIdx = code.indexOf('selectors:[["app-header"]]');
const constsIdx = code.lastIndexOf('consts:[', headerIdx);
const templateStr = code.slice(constsIdx, headerIdx);

const texts = Array.from(templateStr.matchAll(/Ta\([0-9]+,\s*["']([^"']+)["']\)/g))
  .map(m => m[1].replace(/\\n/g, '').trim())
  .filter(t => t.length > 0 && t !== 'shopping_cart' && t !== 'account_circle' && t !== 'menu' && t !== 'file_copy' && t !== 'swap_horiz' && t !== 'category');

console.log('Unique menu labels:', Array.from(new Set(texts)));

fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/header_menu_texts.json', JSON.stringify(Array.from(new Set(texts)), null, 2));

