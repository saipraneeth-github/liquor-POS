import fs from 'fs';
import path from 'path';

const appPath = path.resolve('src/app.ts');
let content = fs.readFileSync(appPath, 'utf8');

// Replace preview.html serving logic with serving static Vite frontend in production,
// but keep fallback to preview.html if needed or just replace it.

content = content.replace(
  `const htmlPath = path.resolve(process.cwd(), 'preview.html');
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        return reply.type('text/html').send(html);
      }`,
  `const htmlPath = path.resolve(process.cwd(), 'frontend/dist/index.html');
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        return reply.type('text/html').send(html);
      }`
);

fs.writeFileSync(appPath, content);
