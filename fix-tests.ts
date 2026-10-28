import fs from 'fs';
import path from 'path';

const specPath = path.resolve('tests/e2e/accounting-and-roles.spec.ts');
let spec = fs.readFileSync(specPath, 'utf8');

// The legacy app used window.showPage. We use window.location.href or React Router in testing.
spec = spec.replace(
  `await page.evaluate(() => (window as unknown as { showPage: (p: string) => void }).showPage('accounting'));`,
  `await page.goto('/accounting');`
);

fs.writeFileSync(specPath, spec);
