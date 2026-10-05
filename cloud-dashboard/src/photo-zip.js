import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { config } from './config.js';
import { getDb } from './db.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(day) {
  return typeof day === 'string' && DAY_RE.test(day);
}

/** Event days that have at least one stored photo (full files). */
export function listPhotoDays() {
  return getDb()
    .prepare(
      `SELECT sess.event_date AS day,
              COUNT(*) AS photoCount,
              COALESCE(SUM(p.bytes), 0) AS bytes
       FROM photos p
       JOIN sessions sess ON sess.id = p.session_id
       GROUP BY sess.event_date
       ORDER BY sess.event_date DESC`,
    )
    .all()
    .map((r) => ({
      day: r.day,
      photoCount: r.photoCount,
      bytes: r.bytes,
    }));
}

function listPhotosForZip(day) {
  if (day) {
    return getDb()
      .prepare(
        `SELECT p.*, sess.slug AS session_slug, sess.event_date AS event_day
         FROM photos p
         JOIN sessions sess ON sess.id = p.session_id
         WHERE sess.event_date = ?
         ORDER BY sess.slug ASC, p.created_at ASC`,
      )
      .all(day);
  }
  return getDb()
    .prepare(
      `SELECT p.*, sess.slug AS session_slug, sess.event_date AS event_day
       FROM photos p
       JOIN sessions sess ON sess.id = p.session_id
       ORDER BY sess.event_date ASC, sess.slug ASC, p.created_at ASC`,
    )
    .all();
}

function safeZipPart(raw, fallback = 'file') {
  const s = String(raw || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

function zipEntryName(row, usedNames) {
  const day = safeZipPart(row.event_day, 'day');
  const slug = safeZipPart(row.session_slug, 'album');
  const label = safeZipPart(row.can_label || row.variant || 'photo', 'photo');
  const baseName = path.basename(String(row.filename || 'photo.jpg'));
  const ext = path.extname(baseName) || '.jpg';
  let name = `${day}/${slug}/${label}_${row.id}${ext}`;
  if (usedNames.has(name)) {
    name = `${day}/${slug}/${label}_${row.id}_${usedNames.size}${ext}`;
  }
  usedNames.add(name);
  return name;
}

/**
 * Stream a zip of full-resolution stored photo files to the Express response.
 * @param {import('express').Response} res
 * @param {{ day?: string }} opts  If day is set (YYYY-MM-DD), only that event day.
 */
export function streamPhotosZip(res, opts = {}) {
  const day = opts.day ? String(opts.day).trim() : '';
  if (day && !isValidDay(day)) {
    res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD' });
    return;
  }

  const rows = listPhotosForZip(day || null);
  if (!rows.length) {
    res.status(404).json({ ok: false, error: day ? `No photos for ${day}` : 'No photos to download' });
    return;
  }

  const usedNames = new Set();
  const entries = [];
  for (const row of rows) {
    const filePath = path.join(config.photosDir, row.session_slug, row.filename);
    if (!fs.existsSync(filePath)) continue;
    entries.push({ filePath, name: zipEntryName(row, usedNames) });
  }
  if (!entries.length) {
    res.status(404).json({ ok: false, error: 'Photo files missing on disk' });
    return;
  }

  const stamp = day || 'all';
  const filename = `zyn-photos-${stamp}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message || 'Zip failed' });
    } else {
      res.destroy(err);
    }
  });
  archive.pipe(res);
  for (const entry of entries) {
    archive.file(entry.filePath, { name: entry.name });
  }
  archive.finalize();
}
