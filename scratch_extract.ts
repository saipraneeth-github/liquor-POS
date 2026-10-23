import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

// 1. Find routes
// In Angular, routes are defined as: path:"login",component:... or path:'dashboard',children:...
const routeRegex = /path:\s*["']([^"']*)["']/g;
const paths = new Set();
let m;
while ((m = routeRegex.exec(code)) !== null) {
  paths.add(m[1]);
}

// Also find objects with path: "...", component: ...
const routeObjRegex = /\{\s*path:\s*["']([^"']*)["'][^}]*\}/g;
const routeObjects = [];
while ((m = routeObjRegex.exec(code)) !== null) {
  routeObjects.push(m[0]);
}

// 2. Find API URLs and service endpoints
const apiRegex = /["'](https?:\/\/[^"']+|(?:\/api|\/rest|\/v1|\/lctg)[^"']*)["']/g;
const apis = new Set();
while ((m = apiRegex.exec(code)) !== null) {
  apis.add(m[1]);
}

// 3. Find HTTP calls: .get(, .post(, .put(, .delete(
const httpCallsRegex = /(?:this\.http|http)\.(get|post|put|delete|patch)\s*(?:<[^>]+>)?\s*\(\s*([^,\)]+)/g;
const httpCalls = [];
while ((m = httpCallsRegex.exec(code)) !== null) {
  httpCalls.push({ method: m[1], urlExpr: m[2].trim() });
}

// 4. Find component class names and selectors
const selectorRegex = /selector:\s*["']([^"']+)["']/g;
const selectors = new Set();
while ((m = selectorRegex.exec(code)) !== null) {
  selectors.add(m[1]);
}

// 5. Look for backend base URL or environment configs
const envMatches = code.match(/apiUrl:\s*["']([^"']+)["']/g) || [];
const hostMatches = code.match(/(https?:\/\/[a-zA-Z0-9\.\-_:]+(?:\/api[a-zA-Z0-9\.\-_\/]*))/g) || [];

fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/extracted_routes.json', JSON.stringify({
  paths: Array.from(paths),
  routeObjects: routeObjects.slice(0, 100),
  apis: Array.from(apis),
  httpCalls: httpCalls.slice(0, 150),
  selectors: Array.from(selectors),
  envMatches,
  hostMatches: Array.from(new Set(hostMatches)),
}, null, 2));

console.log('Found paths:', Array.from(paths));
console.log('Found selectors count:', selectors.size);
console.log('Found APIs:', Array.from(apis).slice(0, 30));

