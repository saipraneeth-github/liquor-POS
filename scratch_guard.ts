import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

// Find gH definition
const idx = code.indexOf('class gH');
if (idx !== -1) {
  console.log('gH snippet:', code.slice(idx, idx + 800));
} else {
  const gHMatches = Array.from(code.matchAll(/class ([a-zA-Z0-9_]+)[\s\S]*?canActivate\s*\(/g)).map(m => m[0]);
  console.log('canActivate classes:', gHMatches.slice(0, 3));
}

