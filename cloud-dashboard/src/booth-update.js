import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { getDb, loadSettings, saveSettings, resolvePublicBaseUrl } from './db.js';
import { requireAdminPin, requireUploadToken } from './auth.js';
import { execFileSync } from 'node:child_process';

function ensureUpdatesDir() {
  fs.mkdirSync(config.boothUpdatesDir, { recursive: true });
  return config.boothUpdatesDir;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseVersionParts(v) {
  return String(v || '0')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

export function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function publicRelease(row) {
  return {
    id: row.id,
    version: row.version,
    buildId: row.build_id,
    bytes: row.bytes,
    sha256: row.sha256 || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    filename: row.filename,
    downloadUrl: `${resolvePublicBaseUrl()}/api/booth-update/download/${encodeURIComponent(row.id)}`,
    adminDownloadUrl: `/api/admin/booth-updates/${encodeURIComponent(row.id)}/download`,
  };
}

/** Read version.json from a Folder zip (Windows PowerShell; optional elsewhere). */
function readVersionFromZip(zipPath) {
  try {
    if (process.platform === 'win32') {
      const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead(${JSON.stringify(zipPath)})
try {
  $e = $z.Entries | Where-Object { $_.FullName -match '(^|/)version\\.json$' } | Select-Object -First 1
  if (-not $e) { return }
  $sr = New-Object IO.StreamReader($e.Open())
  try { $sr.ReadToEnd() } finally { $sr.Close() }
} finally { $z.Dispose() }
`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60000,
      }).trim();
      if (!out) return null;
      const j = JSON.parse(out);
      return {
        version: String(j.version || '').trim() || null,
        buildId: String(j.buildId || '').trim() || null,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function parseMetaFromFilename(name) {
  const m = String(name || '').match(
    /ZYN-Photobooth-(\d+\.\d+\.\d+(?:[.-][\w.]+)?)-([0-9]{8}-[0-9]{6}|\d{14})/i,
  );
  if (!m) return null;
  return { version: m[1], buildId: m[2] };
}

function getActiveReleaseId() {
  return String(loadSettings().boothUpdateActiveId || '').trim();
}

function getActiveRelease() {
  const id = getActiveReleaseId();
  if (!id) return null;
  return getDb().prepare('SELECT * FROM booth_releases WHERE id = ?').get(id) || null;
}

const diskUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, ensureUpdatesDir()),
    filename: (_req, file, cb) => {
      const safe = path.basename(file.originalname || 'update.zip').replace(/[^a-zA-Z0-9._-]+/g, '-');
      cb(null, `upload-${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 600 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!(file.originalname || '').toLowerCase().endsWith('.zip')) {
      cb(new Error('Upload must be a .zip of the ZYN-Photobooth Folder build'));
      return;
    }
    cb(null, true);
  },
});

export const boothUpdateRouter = Router();
export const adminBoothUpdateRouter = Router();

adminBoothUpdateRouter.use(requireAdminPin);

adminBoothUpdateRouter.get('/', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM booth_releases ORDER BY created_at DESC').all();
  const activeId = getActiveReleaseId();
  return res.json({
    ok: true,
    activeId: activeId || null,
    releases: rows.map((r) => ({ ...publicRelease(r), active: r.id === activeId })),
  });
});

adminBoothUpdateRouter.post('/', (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);
  diskUpload.single('package')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || 'Upload failed' });
    try {
      if (!req.file?.path) {
        return res.status(400).json({ ok: false, error: 'Missing package file (field: package)' });
      }
      const fromZip = readVersionFromZip(req.file.path);
      const fromName = parseMetaFromFilename(req.file.originalname || req.file.filename);
      let version = String(req.body?.version || '').trim() || fromZip?.version || fromName?.version || '';
      if (!/^\d+\.\d+\.\d+([.-][\w.]+)?$/.test(version)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({
          ok: false,
          error: 'version required (semver, e.g. 1.1.1) — set the field or use a stamped Folder zip',
        });
      }
      const buildId =
        String(req.body?.buildId || '').trim() ||
        fromZip?.buildId ||
        fromName?.buildId ||
        new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      const notes = String(req.body?.notes || '').trim().slice(0, 2000);
      const id = nanoid(12);
      const filename = `ZYN-Photobooth-${version}-${buildId}.zip`;
      const dest = path.join(ensureUpdatesDir(), filename);
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(req.file.path, dest);
      const st = fs.statSync(dest);
      const sha256 = await sha256File(dest);
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
          notes,
          created_at: createdAt,
        });
      return res.json({
        ok: true,
        release: { ...publicRelease({ id, version, build_id: buildId, filename, bytes: st.size, sha256, notes, created_at: createdAt }), active: false },
      });
    } catch (e) {
      try {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      return res.status(500).json({ ok: false, error: e?.message || 'Upload failed' });
    }
  });
});

adminBoothUpdateRouter.post('/clear-rollout', (_req, res) => {
  saveSettings({ boothUpdateActiveId: '' });
  return res.json({ ok: true, activeId: null });
});

adminBoothUpdateRouter.get('/:id/download', (req, res) => {
  const row = getDb().prepare('SELECT * FROM booth_releases WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Release not found' });
  const filePath = path.join(ensureUpdatesDir(), row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Package file missing on server' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(row.bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
  if (row.sha256) res.setHeader('X-Content-SHA256', row.sha256);
  req.setTimeout(0);
  res.setTimeout(0);
  return fs.createReadStream(filePath).pipe(res);
});

adminBoothUpdateRouter.post('/:id/rollout', (req, res) => {
  const row = getDb().prepare('SELECT * FROM booth_releases WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Release not found' });
  saveSettings({ boothUpdateActiveId: row.id });
  return res.json({ ok: true, activeId: row.id, release: { ...publicRelease(row), active: true } });
});

adminBoothUpdateRouter.delete('/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM booth_releases WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Release not found' });
  const filePath = path.join(ensureUpdatesDir(), row.filename);
  getDb().prepare('DELETE FROM booth_releases WHERE id = ?').run(row.id);
  if (getActiveReleaseId() === row.id) saveSettings({ boothUpdateActiveId: '' });
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
  return res.json({ ok: true });
});

boothUpdateRouter.get('/check', requireUploadToken, (req, res) => {
  const currentVersion = String(req.query.currentVersion || req.query.version || '').trim();
  const currentBuildId = String(req.query.buildId || '').trim();
  const active = getActiveRelease();
  if (!active) return res.json({ ok: true, updateAvailable: false, active: null });
  const newerVersion = compareVersions(currentVersion, active.version) < 0;
  const sameVersionDifferentBuild =
    compareVersions(currentVersion, active.version) === 0 &&
    !!currentBuildId &&
    !!active.build_id &&
    currentBuildId !== active.build_id;
  return res.json({
    ok: true,
    updateAvailable: !currentVersion || newerVersion || sameVersionDifferentBuild,
    active: {
      ...publicRelease(active),
      downloadUrl: `/api/booth-update/download/${encodeURIComponent(active.id)}`,
    },
  });
});

boothUpdateRouter.get('/download/:id', requireUploadToken, (req, res) => {
  const row = getDb().prepare('SELECT * FROM booth_releases WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Release not found' });
  const filePath = path.join(ensureUpdatesDir(), row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Package file missing on server' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(row.bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
  if (row.sha256) res.setHeader('X-Content-SHA256', row.sha256);
  req.setTimeout(0);
  res.setTimeout(0);
  return fs.createReadStream(filePath).pipe(res);
});
