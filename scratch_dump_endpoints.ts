import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

const startIdx = code.indexOf('this.serverLink="/lctg/api/"');
if (startIdx !== -1) {
  const classEnd = code.lastIndexOf('constructor(', startIdx);
  let braceCount = 0;
  let endPos = classEnd;
  const bodyStart = code.indexOf('{', classEnd);
  for (let i = bodyStart; i < code.length; i++) {
    if (code[i] === '{') braceCount++;
    else if (code[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        endPos = i;
        break;
      }
    }
  }

  const constructorBody = code.slice(bodyStart, endPos + 1);
  fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/resturls_constructor.js', constructorBody);
  
  const urlRegex = /this\.([a-zA-Z0-9_]+)\s*=\s*this\.serverLink\s*\+\s*["']([^"']+)["']/g;
  const endpoints: any[] = [];
  let m;
  while ((m = urlRegex.exec(constructorBody)) !== null) {
    endpoints.push({ propName: m[1], path: '/lctg/api/' + m[2] });
  }

  fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/endpoints.json', JSON.stringify(endpoints, null, 2));
  console.log('Total extracted endpoints:', endpoints.length);
  console.log('First 10 endpoints:', endpoints.slice(0, 10));
}

