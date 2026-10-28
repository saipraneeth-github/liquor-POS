import fs from 'fs';
import path from 'path';

const configPath = path.resolve('frontend/vite.config.ts');
let config = fs.readFileSync(configPath, 'utf8');
if (!config.includes('build:')) {
  config = config.replace(
    'server:',
    `build: { outDir: '../dist/frontend', emptyOutDir: true },\n  server:`
  );
}
fs.writeFileSync(configPath, config);
