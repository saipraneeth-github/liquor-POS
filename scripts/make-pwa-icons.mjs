// Draws the app icons (a bottle on the brand green) into frontend/public/icons with the canvas library the server already has.
//   node scripts/make-pwa-icons.mjs
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'frontend/public/icons';
mkdirSync(OUT, { recursive: true });

function draw(size, { maskable = false } = {}) {
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  // background: the dark brand green, full bleed (a maskable icon must not rely on transparent corners)
  g.fillStyle = '#0a1310';
  if (maskable) g.fillRect(0, 0, size, size);
  else { const r = size * 0.22; g.beginPath(); g.moveTo(r, 0); g.arcTo(size, 0, size, size, r); g.arcTo(size, size, 0, size, r); g.arcTo(0, size, 0, 0, r); g.arcTo(0, 0, size, 0, r); g.closePath(); g.fill(); }

  // the bottle, centred inside the safe zone (a maskable icon keeps important art within the middle 80%)
  const s = size * (maskable ? 0.52 : 0.62);
  const cx = size / 2;
  const top = (size - s) / 2;
  const bodyW = s * 0.5;
  const neckW = s * 0.2;
  g.fillStyle = '#4ade80';
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill(); };
  rr(cx - neckW * 0.55, top, neckW * 1.1, s * 0.1, s * 0.02);                    // cap
  rr(cx - neckW / 2, top + s * 0.09, neckW, s * 0.28, s * 0.02);                 // neck
  rr(cx - bodyW / 2, top + s * 0.33, bodyW, s * 0.67, s * 0.1);                  // body
  g.fillStyle = '#0a1310';
  rr(cx - bodyW * 0.32, top + s * 0.55, bodyW * 0.64, s * 0.3, s * 0.03);        // label
  g.fillStyle = '#4ade80';
  rr(cx - bodyW * 0.22, top + s * 0.62, bodyW * 0.44, s * 0.04, s * 0.01);
  rr(cx - bodyW * 0.22, top + s * 0.72, bodyW * 0.3, s * 0.04, s * 0.01);
  return c.toBuffer('image/png');
}

for (const [name, size, opts] of [['icon-192.png', 192, {}], ['icon-512.png', 512, {}], ['icon-maskable-512.png', 512, { maskable: true }], ['apple-touch-icon.png', 180, { maskable: true }]]) {
  writeFileSync(`${OUT}/${name}`, draw(size, opts));
  console.log('wrote', `${OUT}/${name}`);
}
