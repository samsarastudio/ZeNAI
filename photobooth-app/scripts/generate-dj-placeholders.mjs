/**
 * Generates 5 placeholder DJ booth gradient backgrounds for demo/testing.
 * Run: node scripts/generate-dj-placeholders.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'config', 'ai-backgrounds', 'dj');

const palettes = [
  { top: '#1a0a2e', bottom: '#ff6b35', accent: '#ffd166' },
  { top: '#0d1b2a', bottom: '#7b2cbf', accent: '#e0aaff' },
  { top: '#14213d', bottom: '#fca311', accent: '#ffffff' },
  { top: '#240046', bottom: '#3c096c', accent: '#ff8500' },
  { top: '#03045e', bottom: '#00b4d8', accent: '#caf0f8' },
];

fs.mkdirSync(outDir, { recursive: true });

const w = 1536;
const h = 1024;

for (let i = 0; i < palettes.length; i++) {
  const { top, bottom, accent } = palettes[i];
  const svg = `
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${top}"/>
      <stop offset="100%" stop-color="${bottom}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect x="80" y="520" width="1376" height="380" rx="24" fill="rgba(0,0,0,0.45)" stroke="${accent}" stroke-width="4"/>
  <text x="768" y="200" text-anchor="middle" fill="${accent}" font-family="Arial,sans-serif" font-size="56" font-weight="700">BRAND</text>
  <text x="768" y="290" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-size="36" opacity="0.9">DJ BOOTH — placeholder ${i + 1}</text>
  <text x="768" y="720" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-size="28" opacity="0.75">Replace with final branded background art</text>
</svg>`;
  const outPath = path.join(outDir, `dj-placeholder-${i + 1}.png`);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log('Wrote', outPath);
}
