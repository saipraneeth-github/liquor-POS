import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

const headerIdx = code.indexOf('selectors:[["app-header"]]');
if (headerIdx !== -1) {
  // Let's get 30000 chars before and after headerIdx
  const snippet = code.slice(headerIdx - 20000, headerIdx + 15000);
  
  // Extract all text inside Ta(...) or strings near routerLink
  const menuButtons = Array.from(snippet.matchAll(/routerLink\s*,\s*["']([^"']+)["'][^\]]*\][\s\S]*?Ta\([0-9]+,\s*["']([^"']+)["']\)/g))
    .map(m => ({ route: m[1], label: m[2] }));

  // Extract all consts with routerLink
  const allLinks = Array.from(snippet.matchAll(/\[["']routerLink["'],\s*["']([^"']+)["']\]/g)).map(m => m[1]);

  console.log('Header routerLinks:', Array.from(new Set(allLinks)));

  fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/header_analysis.json', JSON.stringify({
    allLinks: Array.from(new Set(allLinks)),
    menuButtons,
  }, null, 2));
}

