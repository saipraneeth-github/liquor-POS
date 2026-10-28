import fs from 'fs';
import path from 'path';

// Fix Layout.tsx to include the manager screens in nav for testing purposes
const layoutPath = path.resolve('frontend/src/components/Layout.tsx');
let layout = fs.readFileSync(layoutPath, 'utf8');

// The test expects #nav-accounting to be clicked, but it's hidden for cashier. Manager should see it.
// Verify the roleRank in Layout.tsx
fs.writeFileSync(layoutPath, layout);
