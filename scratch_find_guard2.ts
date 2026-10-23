import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

const regex = /([a-zA-Z0-9_$]+)\s*=\s*\(\s*\(\)\s*=>\s*\{\s*class\s+t[\s\S]*?canActivate/g;
let m;
while ((m = regex.exec(code)) !== null) {
  console.log('Guard class definition:', m[1], code.slice(m.index, m.index + 500));
}

