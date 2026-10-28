import fs from 'fs';
import path from 'path';

const configPath = path.resolve('playwright.config.ts');
let config = fs.readFileSync(configPath, 'utf8');

config = config.replace(
  'npm run build:frontend && node --import tsx src/dev-local.ts',
  'node --import tsx src/dev-local.ts' // Revert to only starting backend, since we build frontend manually before running tests.
);

fs.writeFileSync(configPath, config);
