import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

const gHIdx = code.indexOf('class gH');
if (gHIdx !== -1) {
  console.log('gH direct match:', code.slice(gHIdx, gHIdx + 600));
} else {
  // search for let gH= or var gH= or const gH=
  const match = code.match(/(?:let|var|const)\s+gH\s*=\s*[\s\S]{0,300}/);
  if (match) console.log('gH var match:', match[0]);
}

