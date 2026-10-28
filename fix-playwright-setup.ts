import fs from 'fs';
import path from 'path';

// Fix the setup process to properly run the build before tests
const configPath = path.resolve('playwright.config.ts');
let config = fs.readFileSync(configPath, 'utf8');

// The backend handles E2E serving correctly without building frontend if we don't mess with it.
// We must build frontend manually using `npm run build:frontend` before tests.
config = config.replace(
  'npm run build:frontend && node --import tsx src/dev-local.ts',
  'node --import tsx src/dev-local.ts'
);

fs.writeFileSync(configPath, config);
