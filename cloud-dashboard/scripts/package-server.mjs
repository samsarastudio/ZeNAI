/**
 * Build a source-only zip for DigitalOcean / Linux hosting.
 *   node scripts/package-server.mjs
 *
 * Output: ../builds/ZYN-Cloud-Dashboard-<version>-server-<stamp>.zip
 * Excludes: node_modules, .env, data/, local caches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, '..');
const buildsRoot = path.join(appRoot, '..', 'builds');
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

const SKIP_DIRS = new Set([
  'node_modules',
  'data',
  '.git',
  '.cursor',
  'coverage',
  'dist',
  'tmp',
  'temp',
]);

const SKIP_FILES = new Set(['.env', '.DS_Store', 'Thumbs.db']);

function shouldSkip(relPosix) {
  const parts = relPosix.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] || '';
  if (SKIP_FILES.has(base)) return true;
  if (base.startsWith('_') && base.endsWith('.mjs') && parts.includes('scripts')) return true;
  if (base.endsWith('.log')) return true;
  return false;
}

function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = path.relative(base, abs);
    const relPosix = rel.split(path.sep).join('/');
    if (shouldSkip(relPosix)) continue;
    if (ent.isDirectory()) walk(abs, base, out);
    else out.push({ abs, relPosix });
  }
}

const buildId = stamp();
const name = `ZYN-Cloud-Dashboard-${version}-server-${buildId}`;
fs.mkdirSync(buildsRoot, { recursive: true });
const zipPath = path.join(buildsRoot, `${name}.zip`);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const files = [];
walk(appRoot, appRoot, files);

if (!files.some((f) => f.relPosix === 'package.json')) {
  throw new Error('package.json missing from package set');
}
if (!files.some((f) => f.relPosix === 'src/index.js')) {
  throw new Error('src/index.js missing from package set');
}

const staging = path.join(buildsRoot, `.staging-${name}`);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

for (const f of files) {
  const dest = path.join(staging, f.relPosix);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f.abs, dest);
}

fs.writeFileSync(
  path.join(staging, 'version.json'),
  JSON.stringify(
    {
      productName: 'ZYN Cloud Dashboard',
      version,
      buildId,
      builtAt: new Date().toISOString(),
      channel: 'server',
    },
    null,
    2,
  ),
  'utf8',
);

const ps = `
$ErrorActionPreference = 'Stop'
$src = ${JSON.stringify(staging)}
$zip = ${JSON.stringify(zipPath)}
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zip -CompressionLevel Optimal
`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  windowsHide: true,
  stdio: 'inherit',
});

fs.rmSync(staging, { recursive: true, force: true });

const st = fs.statSync(zipPath);
console.log(`[package-server] ${zipPath}`);
console.log(`[package-server] ${files.length + 1} entries, ${(st.size / 1048576).toFixed(2)} MB`);
console.log('[package-server] Upload this zip to the host, then:');
console.log('  unzip -o … -d /opt/zyn-cloud-dashboard && cd /opt/zyn-cloud-dashboard');
console.log('  npm install --omit=dev && sudo systemctl restart zyn-cloud-dashboard');
