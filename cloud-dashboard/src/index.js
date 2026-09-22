import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import {
  initDb,
  getDb,
  loadSettings,
  saveSettings,
  isSessionExpired,
  publicPhoto,
  publicSession,
  resolvePublicBaseUrl,
} from './db.js';
import {
  getUploadToken,
  getDisplayToken,
  requireUploadToken,
  requireDisplayOrUploadToken,
  requireAdminPin,
} from './auth.js';
import { emailConfig, sendPhotoEmail } from './email.js';
import { boothUpdateRouter, adminBoothUpdateRouter } from './booth-update.js';
import { framesRouter, sendFrameMedia } from './frames.js';

initDb();

const VARIANTS = new Set(['original', 'framed', 'ai', 'physical']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function slugifyPrefix(raw) {
  const s = String(raw || 'zyn')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'zyn';
}

function todayIso(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDaysIso(from, days) {
  const dt = new Date(from);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString();
}

function getSessionBySlug(slug) {
  return getDb().prepare('SELECT * FROM sessions WHERE slug = ?').get(slug);
}

function listPhotos(sessionId) {
  return getDb()
    .prepare('SELECT * FROM photos WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId);
}

async function maybeEmailAiPhoto(row, session, destPath) {
  const to = String(row.guest_email || '').trim();
  if (row.variant !== 'ai' || !to) {
    getDb().prepare('UPDATE photos SET email_status = ? WHERE id = ?').run(to ? row.email_status : 'skipped', row.id);
    return { emailStatus: to ? row.email_status || 'skipped' : 'skipped' };
  }
  const cfg = emailConfig();
  if (!cfg.enabled) {
    getDb().prepare('UPDATE photos SET email_status = ? WHERE id = ?').run('skipped', row.id);
    return { emailStatus: 'skipped' };
  }
  getDb()
    .prepare('UPDATE photos SET email_status = ?, email_attempts = email_attempts + 1 WHERE id = ?')
    .run('sending', row.id);
  try {
    await sendPhotoEmail({
      to,
      filePath: destPath,
      mime: row.mime,
      filename: row.filename,
    });
    getDb()
      .prepare('UPDATE photos SET email_status = ?, email_error = NULL WHERE id = ?')
      .run('sent', row.id);
    return { emailStatus: 'sent' };
  } catch (e) {
    const msg = String(e?.message || e);
    getDb()
      .prepare('UPDATE photos SET email_status = ?, email_error = ? WHERE id = ?')
      .run('failed', msg, row.id);
    return { emailStatus: 'failed', emailError: msg };
  }
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'zyn-cloud-dashboard',
    port: config.port,
    publicBaseUrl: resolvePublicBaseUrl(),
  });
});

app.get('/api/wall', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT p.*, sess.slug AS session_slug
       FROM photos p JOIN sessions sess ON sess.id = p.session_id
       WHERE p.variant IN ('ai', 'framed') AND IFNULL(p.gallery_picked, 0) = 1
       ORDER BY p.created_at DESC
       LIMIT 200`,
    )
    .all();
  res.json({
    ok: true,
    photos: rows.map((r) => publicPhoto(r.session_slug, r)),
  });
});

app.put('/api/sessions/day', requireUploadToken, (req, res) => {
  const eventPrefix = slugifyPrefix(req.body?.eventPrefix || req.body?.prefix || 'zyn');
  const eventDate =
    typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
      ? req.body.date
      : todayIso();
  const slug = `${eventPrefix}-${eventDate}`;
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : `ZYN ${eventDate}`;
  const settings = loadSettings();
  const now = new Date();
  const existing = getSessionBySlug(slug);
  if (existing) {
    if (isSessionExpired(existing, now)) {
      return res.status(410).json({ ok: false, error: 'Session expired', slug });
    }
    return res.json({ ok: true, session: publicSession(existing, listPhotos(existing.id)) });
  }
  const row = {
    id: nanoid(12),
    slug,
    title,
    event_date: eventDate,
    created_at: now.toISOString(),
    expires_at: addDaysIso(now, settings.defaultTtlDays || config.defaultTtlDays),
  };
  getDb()
    .prepare(
      `INSERT INTO sessions (id, slug, title, event_date, created_at, expires_at)
       VALUES (@id, @slug, @title, @event_date, @created_at, @expires_at)`,
    )
    .run(row);
  return res.status(201).json({ ok: true, session: publicSession(row, []) });
});

app.get('/api/sessions/:slug', (req, res) => {
  const session = getSessionBySlug(req.params.slug);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  const photos = listPhotos(session.id).filter((p) => p.variant !== 'physical');
  return res.json({ ok: true, session: publicSession(session, photos) });
});

app.post('/api/sessions/:slug/photos', requireUploadToken, upload.single('photo'), async (req, res) => {
  const session = getSessionBySlug(req.params.slug);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  if (isSessionExpired(session)) {
    return res.status(410).json({ ok: false, error: 'Session expired' });
  }
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ ok: false, error: 'Missing photo file (field: photo)' });
  }
  const variant = String(req.body?.variant || 'original').toLowerCase();
  if (!VARIANTS.has(variant)) {
    return res.status(400).json({ ok: false, error: 'variant must be original|framed|ai|physical' });
  }
  // Booth cloud gallery is AI-result only.
  if (variant !== 'ai') {
    return res.status(400).json({ ok: false, error: 'Only AI-generated photos may be uploaded' });
  }
  const sourceLocalName = String(req.body?.sourceLocalName || req.file.originalname || '').trim() || null;
  const guestEmail = String(req.body?.guestEmail || req.body?.email || '').trim() || null;
  const canId = String(req.body?.canId || '').trim() || null;
  const canLabel = String(req.body?.canLabel || '').trim() || null;
  const jobId = String(req.body?.jobId || '').trim() || null;
  const capturedRaw = String(req.body?.capturedAt || req.body?.createdAt || '').trim();
  const capturedMs = capturedRaw ? Date.parse(capturedRaw) : NaN;
  const createdAt =
    Number.isFinite(capturedMs) ? new Date(capturedMs).toISOString() : new Date().toISOString();

  if (sourceLocalName) {
    const existing = getDb()
      .prepare(
        `SELECT * FROM photos WHERE session_id = ? AND variant = ? AND source_local_name = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(session.id, variant, sourceLocalName);
    if (existing) {
      const existingPath = path.join(config.photosDir, session.slug, existing.filename);
      if (!fs.existsSync(existingPath) || fs.statSync(existingPath).size <= 0) {
        fs.mkdirSync(path.dirname(existingPath), { recursive: true });
        fs.writeFileSync(existingPath, req.file.buffer);
      }
      if (guestEmail && !existing.guest_email) {
        getDb().prepare('UPDATE photos SET guest_email = ? WHERE id = ?').run(guestEmail, existing.id);
        existing.guest_email = guestEmail;
      }
      const emailResult =
        variant === 'ai'
          ? await maybeEmailAiPhoto({ ...existing, guest_email: guestEmail || existing.guest_email }, session, existingPath)
          : { emailStatus: existing.email_status };
      const fresh = getDb().prepare('SELECT * FROM photos WHERE id = ?').get(existing.id);
      return res.json({ ok: true, photo: publicPhoto(session.slug, fresh), deduped: true, ...emailResult });
    }
  }

  const id = nanoid(14);
  const mime = req.file.mimetype || 'image/jpeg';
  const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg';
  const filename = `${id}${ext}`;
  const sessionDir = path.join(config.photosDir, session.slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  const dest = path.join(sessionDir, filename);
  fs.writeFileSync(dest, req.file.buffer);

  const row = {
    id,
    session_id: session.id,
    variant,
    filename,
    mime,
    bytes: req.file.buffer.length,
    source_local_name: sourceLocalName,
    width: req.body?.width ? Number(req.body.width) : null,
    height: req.body?.height ? Number(req.body.height) : null,
    created_at: createdAt,
    guest_email: guestEmail,
    email_status: variant === 'ai' && guestEmail ? 'queued' : 'skipped',
    email_error: null,
    email_attempts: 0,
    can_id: canId,
    can_label: canLabel,
    job_id: jobId,
    gallery_picked:
      variant === 'ai' && loadSettings().autoGalleryPickAi ? 1 : 0,
  };
  getDb()
    .prepare(
      `INSERT INTO photos
       (id, session_id, variant, filename, mime, bytes, source_local_name, width, height, created_at,
        guest_email, email_status, email_error, email_attempts, can_id, can_label, gallery_picked, job_id)
       VALUES
       (@id, @session_id, @variant, @filename, @mime, @bytes, @source_local_name, @width, @height, @created_at,
        @guest_email, @email_status, @email_error, @email_attempts, @can_id, @can_label, @gallery_picked, @job_id)`,
    )
    .run(row);

  if (jobId && variant === 'ai') {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO booth_jobs (id, can_id, can_label, ai_status, print_status, upload_status, last_error, photo_id, created_at, updated_at)
         VALUES (@id, @can_id, @can_label, 'done', 'idle', 'done', NULL, @photo_id, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           ai_status='done',
           upload_status='done',
           photo_id=excluded.photo_id,
           can_id=COALESCE(excluded.can_id, booth_jobs.can_id),
           can_label=COALESCE(excluded.can_label, booth_jobs.can_label),
           updated_at=excluded.updated_at`,
      )
      .run({
        id: jobId,
        can_id: canId,
        can_label: canLabel,
        photo_id: id,
        created_at: createdAt,
        updated_at: now,
      });
  }

  const emailResult = await maybeEmailAiPhoto(row, session, dest);
  const fresh = getDb().prepare('SELECT * FROM photos WHERE id = ?').get(id);
  return res.status(201).json({ ok: true, photo: publicPhoto(session.slug, fresh), ...emailResult });
});

app.get('/api/display/settings', requireDisplayOrUploadToken, (_req, res) => {
  const s = loadSettings();
  const intervalMs = Number(s.displayIntervalMs) || 8000;
  res.json({
    ok: true,
    display: {
      apiPort: config.port,
      apiToken: getDisplayToken(),
      intervalMs,
      filter: 'all',
    },
    publicBaseUrl: resolvePublicBaseUrl(),
    wallTitle: s.wallTitle || 'ZYN',
  });
});

app.get('/api/display/feed', requireDisplayOrUploadToken, (_req, res) => {
  const s = loadSettings();
  const token = getDisplayToken();
  const rows = getDb()
    .prepare(
      `SELECT p.*, sess.slug AS session_slug
       FROM photos p
       JOIN sessions sess ON sess.id = p.session_id
       WHERE p.variant = 'ai' AND IFNULL(p.gallery_picked, 0) = 1
       ORDER BY p.created_at DESC
       LIMIT 200`,
    )
    .all();
  res.json({
    ok: true,
    intervalMs: Number(s.displayIntervalMs) || 8000,
    items: rows.map((j) => ({
      id: j.id,
      createdAt: j.created_at,
      canId: j.can_id,
      canLabel: j.can_label,
      tags: j.can_id ? [j.can_id] : [],
      imageUrl: `/api/media/${encodeURIComponent(j.id)}?token=${encodeURIComponent(token)}`,
    })),
  });
});

app.get('/api/media/:id', requireDisplayOrUploadToken, (req, res) => {
  const row = getDb()
    .prepare(
      `SELECT p.*, sess.slug AS session_slug
       FROM photos p JOIN sessions sess ON sess.id = p.session_id
       WHERE p.id = ?`,
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  const filePath = path.join(config.photosDir, row.session_slug, row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Not found' });
  res.setHeader('Content-Type', row.mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(path.resolve(filePath));
});

app.use('/api/booth-update', boothUpdateRouter);
app.use('/api/frames', framesRouter);

app.put('/api/booth-jobs/:id', requireUploadToken, (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Missing job id' });
  const body = req.body || {};
  const now = new Date().toISOString();
  const existing = getDb().prepare('SELECT * FROM booth_jobs WHERE id = ?').get(id);
  const row = {
    id,
    can_id: String(body.canId || existing?.can_id || '').trim() || null,
    can_label: String(body.canLabel || existing?.can_label || '').trim() || null,
    ai_status: String(body.aiStatus || existing?.ai_status || 'queued'),
    print_status: String(body.printStatus || existing?.print_status || 'idle'),
    upload_status: String(body.uploadStatus || existing?.upload_status || 'idle'),
    last_error: body.lastError != null ? String(body.lastError) : existing?.last_error || null,
    photo_id: body.photoId != null ? String(body.photoId) : existing?.photo_id || null,
    created_at: existing?.created_at || body.createdAt || now,
    updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO booth_jobs (id, can_id, can_label, ai_status, print_status, upload_status, last_error, photo_id, created_at, updated_at)
       VALUES (@id, @can_id, @can_label, @ai_status, @print_status, @upload_status, @last_error, @photo_id, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         can_id=excluded.can_id,
         can_label=excluded.can_label,
         ai_status=excluded.ai_status,
         print_status=excluded.print_status,
         upload_status=excluded.upload_status,
         last_error=excluded.last_error,
         photo_id=COALESCE(excluded.photo_id, booth_jobs.photo_id),
         updated_at=excluded.updated_at`,
    )
    .run(row);
  return res.json({ ok: true, job: row });
});

app.get('/api/admin/booth-jobs', requireAdminPin, (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT j.*, p.filename AS photo_filename, s.slug AS session_slug
       FROM booth_jobs j
       LEFT JOIN photos p ON p.id = j.photo_id
       LEFT JOIN sessions s ON s.id = p.session_id
       ORDER BY j.updated_at DESC
       LIMIT 100`,
    )
    .all();
  return res.json({
    ok: true,
    jobs: rows.map((r) => ({
      id: r.id,
      canId: r.can_id,
      canLabel: r.can_label,
      aiStatus: r.ai_status,
      printStatus: r.print_status,
      uploadStatus: r.upload_status,
      lastError: r.last_error,
      photoId: r.photo_id,
      photoUrl:
        r.session_slug && r.photo_filename
          ? `/media/${encodeURIComponent(r.session_slug)}/${encodeURIComponent(r.photo_filename)}`
          : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

const admin = express.Router();
admin.use(requireAdminPin);

admin.get('/settings', (_req, res) => {
  const s = loadSettings();
  const uploadToken = getUploadToken();
  const email = emailConfig();
  res.json({
    ok: true,
    settings: {
      defaultTtlDays: s.defaultTtlDays,
      uploadToken,
      uploadTokenConfigured: !!uploadToken,
      displayToken: getDisplayToken(),
      publicBaseUrl: resolvePublicBaseUrl(),
      displayIntervalMs: Number(s.displayIntervalMs) || 8000,
      autoGalleryPickAi: !!s.autoGalleryPickAi,
      emailEnabled: email.enabled,
      sendgridApiUrl: email.apiUrl,
      apiKeyConfigured: !!email.apiKey,
      emailFrom: email.from,
      emailFromName: email.fromName,
      emailSubject: email.subject,
      emailBody: email.body,
    },
  });
});

admin.patch('/settings', (req, res) => {
  const patch = {};
  const body = req.body || {};
  if (body.defaultTtlDays !== undefined) {
    const days = Number(body.defaultTtlDays);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({ ok: false, error: 'defaultTtlDays must be 1–3650' });
    }
    patch.defaultTtlDays = Math.floor(days);
  }
  if (typeof body.uploadToken === 'string') {
    const token = body.uploadToken.trim();
    if (token && token.length < 8) {
      return res.status(400).json({ ok: false, error: 'uploadToken must be at least 8 characters' });
    }
    patch.uploadToken = token;
  }
  if (typeof body.displayToken === 'string') patch.displayToken = body.displayToken.trim();
  if (typeof body.publicBaseUrl === 'string') patch.publicBaseUrl = body.publicBaseUrl.trim().replace(/\/$/, '');
  if (body.displayIntervalMs !== undefined) {
    const ms = Number(body.displayIntervalMs);
    if (!Number.isFinite(ms) || ms < 1000 || ms > 120000) {
      return res.status(400).json({ ok: false, error: 'displayIntervalMs must be 1000–120000' });
    }
    patch.displayIntervalMs = Math.floor(ms);
  }
  if (body.autoGalleryPickAi !== undefined) patch.autoGalleryPickAi = !!body.autoGalleryPickAi;
  if (body.emailEnabled !== undefined) patch.emailEnabled = !!body.emailEnabled;
  if (typeof body.sendgridApiUrl === 'string') patch.sendgridApiUrl = body.sendgridApiUrl.trim();
  if (typeof body.sendgridApiKey === 'string' && body.sendgridApiKey.trim()) {
    patch.sendgridApiKey = body.sendgridApiKey.trim();
  }
  if (typeof body.emailFrom === 'string') patch.emailFrom = body.emailFrom.trim();
  if (typeof body.emailFromName === 'string') patch.emailFromName = body.emailFromName.trim();
  if (typeof body.emailSubject === 'string') patch.emailSubject = body.emailSubject.trim();
  if (typeof body.emailBody === 'string') patch.emailBody = body.emailBody;
  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, error: 'No settings to update' });
  }
  saveSettings(patch);
  return res.json({ ok: true, settings: { publicBaseUrl: resolvePublicBaseUrl(), ...patch } });
});

admin.get('/sessions', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM sessions ORDER BY created_at DESC').all();
  const now = new Date();
  const sessions = rows.map((row) => {
    const count = getDb().prepare('SELECT COUNT(*) AS c FROM photos WHERE session_id = ?').get(row.id).c;
    return { ...publicSession(row, []), photoCount: count, expired: isSessionExpired(row, now) };
  });
  return res.json({ ok: true, sessions });
});

admin.get('/photos', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT p.*, sess.slug AS session_slug, sess.title AS session_title
       FROM photos p JOIN sessions sess ON sess.id = p.session_id
       ORDER BY p.created_at DESC LIMIT 300`,
    )
    .all();
  return res.json({
    ok: true,
    photos: rows.map((r) => ({
      ...publicPhoto(r.session_slug, r),
      sessionSlug: r.session_slug,
      sessionTitle: r.session_title,
    })),
  });
});

admin.post('/photos/:id/email', async (req, res) => {
  const row = getDb()
    .prepare(
      `SELECT p.*, sess.slug AS session_slug FROM photos p
       JOIN sessions sess ON sess.id = p.session_id WHERE p.id = ?`,
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Photo not found' });
  const dest = path.join(config.photosDir, row.session_slug, row.filename);
  const result = await maybeEmailAiPhoto(row, { slug: row.session_slug }, dest);
  const fresh = getDb().prepare('SELECT * FROM photos WHERE id = ?').get(row.id);
  return res.json({ ok: result.emailStatus === 'sent', photo: publicPhoto(row.session_slug, fresh), ...result });
});

admin.patch('/photos/:id', (req, res) => {
  const row = getDb()
    .prepare(
      `SELECT p.*, sess.slug AS session_slug FROM photos p
       JOIN sessions sess ON sess.id = p.session_id WHERE p.id = ?`,
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Photo not found' });
  if (typeof req.body?.galleryPicked !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'galleryPicked (boolean) is required' });
  }
  getDb().prepare('UPDATE photos SET gallery_picked = ? WHERE id = ?').run(req.body.galleryPicked ? 1 : 0, row.id);
  const fresh = getDb().prepare('SELECT * FROM photos WHERE id = ?').get(row.id);
  return res.json({ ok: true, photo: publicPhoto(row.session_slug, fresh) });
});

admin.delete('/photos/:id', (req, res) => {
  const row = getDb()
    .prepare(
      `SELECT p.*, sess.slug AS session_slug FROM photos p
       JOIN sessions sess ON sess.id = p.session_id WHERE p.id = ?`,
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Photo not found' });
  const dest = path.join(config.photosDir, row.session_slug, row.filename);
  getDb().prepare('DELETE FROM photos WHERE id = ?').run(row.id);
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
  } catch {
    /* ignore */
  }
  return res.json({ ok: true });
});

admin.get('/overview', (_req, res) => {
  const albums = getDb().prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  const photos = getDb().prepare('SELECT COUNT(*) AS c FROM photos').get().c;
  const emailed = getDb().prepare(`SELECT COUNT(*) AS c FROM photos WHERE email_status = 'sent'`).get().c;
  const failed = getDb().prepare(`SELECT COUNT(*) AS c FROM photos WHERE email_status = 'failed'`).get().c;
  const gallery = getDb().prepare(`SELECT COUNT(*) AS c FROM photos WHERE gallery_picked = 1`).get().c;
  const releases = getDb().prepare('SELECT COUNT(*) AS c FROM booth_releases').get().c;
  res.json({ ok: true, albums, photos, emailed, failed, gallery, releases });
});

app.use('/api/admin/booth-updates', adminBoothUpdateRouter);
app.use('/api/admin', admin);

app.get('/media/frames/:filename', sendFrameMedia);

app.get('/media/:slug/:filename', (req, res) => {
  const slug = path.basename(req.params.slug);
  const filename = path.basename(req.params.filename);
  if (filename.includes('..') || slug.includes('..')) return res.status(400).end();
  const filePath = path.join(config.photosDir, slug, filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  return res.sendFile(path.resolve(filePath));
});

app.use(express.static(config.publicDir, { index: false, maxAge: 0 }));

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(config.publicDir, 'admin.html'));
});

app.get(['/', '/wall', '/:slug', '/:slug/p/:photoId'], (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
  res.sendFile(path.join(config.publicDir, 'gallery.html'));
});

app.listen(config.port, config.host, () => {
  console.log(`[zyn-cloud] listening on http://${config.host}:${config.port}`);
  console.log(`[zyn-cloud] admin  http://127.0.0.1:${config.port}/admin`);
  console.log(`[zyn-cloud] health http://127.0.0.1:${config.port}/api/health`);
});
