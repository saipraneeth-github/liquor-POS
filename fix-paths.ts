import fs from 'fs';
import path from 'path';

const appPath = path.resolve('src/app.ts');
let content = fs.readFileSync(appPath, 'utf8');

content = content.replace(
  "root: path.join(process.cwd(), 'frontend/dist'),",
  "root: path.join(process.cwd(), 'dist/frontend'),"
);

content = content.replace(
  "const htmlPath = path.resolve(process.cwd(), 'frontend/dist/index.html');",
  "const htmlPath = path.resolve(process.cwd(), 'dist/frontend/index.html');"
);

fs.writeFileSync(appPath, content);
