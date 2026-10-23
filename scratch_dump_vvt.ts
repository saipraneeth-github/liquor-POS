import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

const idx = code.indexOf('const Vvt=[');
if (idx !== -1) {
  const endIdx = code.indexOf('];', idx);
  const routeArrayStr = code.slice(idx, endIdx + 2);
  fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/vvt_routes.js', routeArrayStr);
  console.log('Saved Vvt routes. Length:', routeArrayStr.length);
}

