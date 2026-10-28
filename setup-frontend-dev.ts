import fs from 'fs';
import path from 'path';
const pkgPath = path.resolve('package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

pkg.scripts['dev:frontend'] = 'cd frontend && npm run dev';
pkg.scripts['build:frontend'] = 'cd frontend && npm run build';
pkg.scripts['build'] = 'npm run build:frontend && tsc';

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
