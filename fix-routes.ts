import fs from 'fs';
import path from 'path';

const appPath = path.resolve('src/app.ts');
let content = fs.readFileSync(appPath, 'utf8');

// fastifyStatic provides its own GET / when serving index.html if root matches index.html,
// but we might have another GET / manually defined, let's look for fastify.get('/', ...) and remove it.

const getRootRegex = /fastify\.get\('\/', async \(request, reply\) => \{[\s\S]*?\}\);/;
content = content.replace(getRootRegex, '');

fs.writeFileSync(appPath, content);
