import fs from 'fs';
import path from 'path';

const configPath = path.resolve('playwright.config.ts');
let config = fs.readFileSync(configPath, 'utf8');

// The backend dev script now starts fastify serving the frontend static build.
// Or we can just start both using npm run dev. Let's start the combined build in e2e.

config = config.replace(
  'node --import tsx src/dev-local.ts',
  'npm run build:frontend && node --import tsx src/dev-local.ts'
);

fs.writeFileSync(configPath, config);
