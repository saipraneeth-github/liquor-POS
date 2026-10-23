import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

// Find app-header definition
const headerIdx = code.indexOf('app-header');
console.log('Snippet around app-header:');
const classIdx = code.lastIndexOf('class ', headerIdx);
const templateIdx = code.indexOf('template:function', headerIdx);
if (templateIdx !== -1) {
  console.log(code.slice(templateIdx - 200, templateIdx + 3000));
}

