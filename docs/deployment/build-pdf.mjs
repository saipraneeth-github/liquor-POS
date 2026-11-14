// Renders deployment-plan.html to deployment-plan.pdf with headless Chromium (Playwright). No network access needed.
//   node docs/deployment/build-pdf.mjs
import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(path.join(dir, 'deployment-plan.html')).href, { waitUntil: 'load' });
await page.pdf({
  path: path.join(dir, 'deployment-plan.pdf'),
  format: 'A4', printBackground: true,
  margin: { top: '18mm', bottom: '17mm', left: '16mm', right: '16mm' },
  displayHeaderFooter: true,
  headerTemplate: '<div style="font:7.5pt Segoe UI,Arial;color:#6b7b74;width:100%;padding:0 16mm;display:flex;justify-content:space-between"><span>Deployment Plan — Liquor Counter POS</span><span>v1.0 draft · 2026-11-13</span></div>',
  footerTemplate: '<div style="font:7.5pt Segoe UI,Arial;color:#6b7b74;width:100%;padding:0 16mm;display:flex;justify-content:space-between"><span>Confidential — internal use</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
});
await browser.close();
console.log('written');
