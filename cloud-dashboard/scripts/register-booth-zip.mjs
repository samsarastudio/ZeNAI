/**
 * Register a Folder build zip for kiosk OTA.
 *
 *   node scripts/register-booth-zip.mjs "F:\...\ZYN-Photobooth-Folder-1.1.1-20260908-153336.zip"
 *   node scripts/register-booth-zip.mjs path\to.zip --rollout
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { config } from '../src/config.js';
import { initDb, getDb, saveSettings } from '../src/db.js';

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseName(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/ZYN-Photobooth-Folder-(\d+\.\d+\.\d+(?:[.-][\w.]+)?)-([0-9]{8}-[0-9]{6})/i);
  if (m) return { version: m[1], buildId: m[2] };
  const m2 = base.match(/ZYN-Photobooth-(\d+\.\d+\.\d+(?:[.-][\w.]+)?)-([0-9]{8}-[0-9]{6})/i);
  if (m2) return { version: m2[1], buildId: m2[2] };
  return null;
}

const args = process.argv.slice(2).filter((a) => a !== '--rollout');
const doRollout = process.argv.includes('--rollout');
const zipPath = path.resolve(args[0] || '');
if (!zipPath || !fs.existsSync(zipPath)) {
  console.error('Usage: node scripts/register-booth-zip.mjs <folder-build.zip> [--rollout]');
  process.exit(1);
}
if (!zipPath.toLowerCase().endsWith('.zip')) {
  console.error('File must be a .zip');
  process.exit(1);
}

const parsed = parseName(zipPath);
if (!parsed) {
  console.error('Could not parse version/buildId. Expected ZYN-Photobooth-Folder-<ver>-<YYYYMMDD-HHMMSS>.zip');
  process.exit(1);
}

initDb();
fs.mkdirSync(config.boothUpdatesDir, { recursive: true });

const { version, buildId } = parsed;
const filename = `ZYN-Photobooth-${version}-${buildId}.zip`;
const dest = path.join(config.boothUpdatesDir, filename);
console.log(`[register] Copying → ${dest}`);
fs.copyFileSync(zipPath, dest);
const st = fs.statSync(dest);
const sha256 = await sha256File(dest);
const id = nanoid(12);
const createdAt = new Date().toISOString();

getDb()
  .prepare(
    `INSERT INTO booth_releases (id, version, build_id, filename, bytes, sha256, notes, created_at)
     VALUES (@id, @version, @build_id, @filename, @bytes, @sha256, @notes, @created_at)`,
  )
  .run({
    id,
    version,
    build_id: buildId,
    filename,
    bytes: st.size,
    sha256,
    notes: `Registered locally · Folder build v${version} · build ${buildId}`,
    created_at: createdAt,
  });

if (doRollout) {
  saveSettings({ boothUpdateActiveId: id });
  console.log(`[register] Rolled out as active release ${id}`);
}

console.log(`[register] OK release ${id} v${version} (${buildId})`);
console.log('[register] Open Cloud admin → Booth updates → Roll out if needed.');
