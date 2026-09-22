import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { Router } from 'express';
import { config } from './config.js';
import { requireUploadToken } from './auth.js';

function framesDir() {
  const dir = path.join(config.dataDir, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeFrameName(raw) {
  const base = path.basename(String(raw || '').trim());
  if (!base || base.includes('..')) return null;
  if (!/\.(png|jpe?g|webp)$/i.test(base)) return null;
  return base;
}

function listFrames() {
  const dir = framesDir();
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const safe = safeFrameName(name);
    if (!safe) continue;
    const full = path.join(dir, safe);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({
        filename: safe,
        bytes: st.size,
        url: `/media/frames/${encodeURIComponent(safe)}`,
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

const diskUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export const framesRouter = Router();

framesRouter.get('/', (_req, res) => {
  return res.json({ ok: true, frames: listFrames() });
});

framesRouter.post('/', requireUploadToken, (req, res) => {
  diskUpload.single('frame')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || 'Upload failed' });
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ ok: false, error: 'Missing frame file (field: frame)' });
      }
      const preferred = safeFrameName(req.body?.filename || req.file.originalname);
      if (!preferred) {
        return res.status(400).json({ ok: false, error: 'filename must be .png / .jpg / .webp' });
      }
      const dest = path.join(framesDir(), preferred);
      fs.writeFileSync(dest, req.file.buffer);
      const st = fs.statSync(dest);
      return res.status(201).json({
        ok: true,
        frame: {
          filename: preferred,
          bytes: st.size,
          url: `/media/frames/${encodeURIComponent(preferred)}`,
        },
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'Upload failed' });
    }
  });
});

framesRouter.delete('/:filename', requireUploadToken, (req, res) => {
  const safe = safeFrameName(req.params.filename);
  if (!safe) return res.status(400).json({ ok: false, error: 'Invalid filename' });
  const full = path.join(framesDir(), safe);
  if (!fs.existsSync(full)) return res.json({ ok: true, removed: safe, missing: true });
  try {
    fs.unlinkSync(full);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Delete failed' });
  }
  return res.json({ ok: true, removed: safe });
});

export function sendFrameMedia(req, res) {
  const safe = safeFrameName(req.params.filename);
  if (!safe) return res.status(400).end();
  const full = path.join(framesDir(), safe);
  if (!fs.existsSync(full)) return res.status(404).end();
  const ext = path.extname(safe).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  return res.sendFile(path.resolve(full));
}
