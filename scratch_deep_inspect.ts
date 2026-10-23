import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

// 1. Look for API base URLs or service definitions
const urlMatches = code.match(/https?:\/\/[a-zA-Z0-9\.\-_:]+(?:\/[a-zA-Z0-9\.\-_\/]*)/g) || [];
const uniqueUrls = Array.from(new Set(urlMatches.filter(u => !u.includes('w3.org') && !u.includes('schema') && !u.includes('google'))));

// 2. Look for endpoint paths: `/api/...`, `/liquor...`, `/store...`, etc.
const pathMatches = code.match(/["'](\/[a-zA-Z0-9_\-\/]+)["']/g) || [];
const cleanPaths = Array.from(new Set(pathMatches.map(p => p.slice(1, -1)).filter(p => 
  p.startsWith('/api') || 
  p.startsWith('/login') || 
  p.startsWith('/user') || 
  p.startsWith('/store') || 
  p.startsWith('/product') || 
  p.startsWith('/purchase') || 
  p.startsWith('/sale') || 
  p.startsWith('/report') || 
  p.startsWith('/stock') ||
  p.startsWith('/expense') ||
  p.startsWith('/category') ||
  p.startsWith('/syndicate')
)));

// 3. Find login component code and auth flow
// Let's find zR definition
const zRIdx = code.indexOf('class zR');
let zRSnippet = '';
if (zRIdx !== -1) {
  zRSnippet = code.slice(zRIdx, zRIdx + 3000);
} else {
  // Let's search for "login" component selector or template
  const loginMatch = code.match(/class [a-zA-Z0-9_]+[\s\S]*?selector:\s*["']app-login["'][\s\S]*?\}/);
  if (loginMatch) zRSnippet = loginMatch[0].slice(0, 2000);
}

// 4. Look for Navigation menu / sidebar items
// Angular navigation menus usually have routerLink or nav arrays
const routerLinkMatches = code.match(/routerLink:\s*\[?["']([^"']+)["']\]?/g) || [];
const navTitles = code.match(/title:\s*["']([^"']+)["']/g) || [];

// 5. Look for user roles / permissions
const roleMatches = code.match(/(?:role|Role|userType|ROLES)[^,;]{0,50}/g) || [];

fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/deep_inspection.json', JSON.stringify({
  uniqueUrls,
  cleanPaths,
  zRSnippet: zRSnippet.slice(0, 1500),
  routerLinkMatches: Array.from(new Set(routerLinkMatches)).slice(0, 50),
  navTitles: Array.from(new Set(navTitles)).slice(0, 50),
  roleMatches: Array.from(new Set(roleMatches)).slice(0, 40),
}, null, 2));

console.log('Unique URLs:', uniqueUrls);
console.log('Clean API Paths count:', cleanPaths.length, cleanPaths.slice(0, 30));
console.log('Sample Roles:', Array.from(new Set(roleMatches)).slice(0, 15));

