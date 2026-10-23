import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

// Find serverLink definition
const idx = code.indexOf('serverLink');
console.log('Snippet around serverLink:');
let cur = 0;
while (true) {
  const match = code.indexOf('serverLink', cur);
  if (match === -1) break;
  console.log('Match at', match, ':', code.slice(match - 50, match + 200));
  cur = match + 200;
  if (cur > match + 2000) break;
}

// Find Resturls or resturls service
const restUrlsMatch = code.indexOf('resturls') || code.indexOf('RestUrls');
if (restUrlsMatch !== -1) {
  console.log('Snippet around resturls:', code.slice(restUrlsMatch - 100, restUrlsMatch + 800));
}

