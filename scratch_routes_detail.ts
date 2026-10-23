import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

// Find the main AppRoutingModule / routes definition
// In Angular Ivy/Webpack, it often looks like const routes = [{path:"",...}] or e=[{path:"login",component:...}]
const appRoutesMatch = code.match(/\[\s*\{\s*path:\s*["']login["'][\s\S]*?\];/);
if (appRoutesMatch) {
  fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/app_routes.js', appRoutesMatch[0]);
  console.log('Found app routes match length:', appRoutesMatch[0].length);
} else {
  console.log('App routes match not found directly, searching broader...');
  // Let's find index of 'path:"login"'
  const idx = code.indexOf('path:"login"');
  if (idx !== -1) {
    console.log('Snippet around path:"login":', code.slice(idx - 200, idx + 1000));
  }
}

// Find backend API endpoints
// Search for "api/" or "/service" or similar strings
const apiStrings = new Set();
const apiPattern = /["'`]([a-zA-Z0-9_\-\.\/]+(?:api|service|auth|user|login|product|purchase|sale|stock|scheme|report|expense|counter|payment|invoice)[a-zA-Z0-9_\-\.\/]*)["'`]/gi;
let m;
while ((m = apiPattern.exec(code)) !== null) {
  if (m[1].length > 3 && (m[1].includes('/') || m[1].includes('api') || m[1].includes('login'))) {
    apiStrings.add(m[1]);
  }
}

fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/api_strings.json', JSON.stringify(Array.from(apiStrings), null, 2));
console.log('Found candidate api strings:', apiStrings.size);

