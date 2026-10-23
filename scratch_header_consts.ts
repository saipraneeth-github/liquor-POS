import * as fs from 'fs';

const code = fs.readFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/main.js', 'utf8');

const headerIdx = code.indexOf('selectors:[["app-header"]]');
const constsIdx = code.lastIndexOf('consts:[', headerIdx);
const constsEnd = code.indexOf('],template:', constsIdx);
const constsStr = code.slice(constsIdx, constsEnd + 1);

fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/header_consts.js', constsStr);

const links = Array.from(constsStr.matchAll(/["']routerLink["'],\s*["']([^"']+)["']/g)).map(m => m[1]);
console.log('Found Header routerLinks in consts:', Array.from(new Set(links)));

// Also extract visible text labels
const templateStr = code.slice(constsEnd, headerIdx);
const texts = Array.from(templateStr.matchAll(/Ta\([0-9]+,\s*["']([^"']+)["']\)/g)).map(m => m[1]);
console.log('Sample texts in header template:', texts.slice(0, 40));

