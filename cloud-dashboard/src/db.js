import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';

/** @type {import('better-sqlite3').Database | null} */
let db = null;

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function ensureColumn(database, table, column, typeSql) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
}

export function initDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.photosDir, { recursive: true });
  fs.mkdirSync(config.boothUpdatesDir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      variant TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      source_local_name TEXT,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL,
      guest_email TEXT,
      email_status TEXT,
      email_error TEXT,
      email_attempts INTEGER NOT NULL DEFAULT 0,
      can_id TEXT,
      can_label TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_photos_session ON photos(session_id, created_at);
    CREATE TABLE IF NOT EXISTS booth_releases (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      build_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'photos', 'guest_email', 'TEXT');
  ensureColumn(db, 'photos', 'email_status', 'TEXT');
  ensureColumn(db, 'photos', 'email_error', 'TEXT');
  ensureColumn(db, 'photos', 'email_attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'photos', 'can_id', 'TEXT');
  ensureColumn(db, 'photos', 'can_label', 'TEXT');
  ensureColumn(db, 'photos', 'gallery_picked', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'photos', 'job_id', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS booth_jobs (
      id TEXT PRIMARY KEY,
      can_id TEXT,
      can_label TEXT,
      ai_status TEXT NOT NULL DEFAULT 'queued',
      print_status TEXT NOT NULL DEFAULT 'idle',
      upload_status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      photo_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_booth_jobs_updated ON booth_jobs(updated_at DESC);
  `);
  return db;
}

const SETTINGS_DEFAULTS = {
  defaultTtlDays: 30,
  uploadToken: '',
  publicBaseUrl: '',
  boothUpdateActiveId: '',
};

/** Prefer admin-saved publicBaseUrl; fall back to PUBLIC_BASE_URL / default. */
export function resolvePublicBaseUrl() {
  try {
    const fromSettings = String(loadSettings().publicBaseUrl || '')
      .trim()
      .replace(/\/$/, '');
    if (fromSettings) return fromSettings;
  } catch {
    /* ignore */
  }
  return config.publicBaseUrl;
}

export function loadSettings() {
  try {
    if (!fs.existsSync(config.settingsPath)) return { ...SETTINGS_DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(config.settingsPath, 'utf8'));
    return { ...SETTINGS_DEFAULTS, ...raw };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.writeFileSync(config.settingsPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function isSessionExpired(session, now = new Date()) {
  return new Date(session.expires_at).getTime() <= now.getTime();
}

export function publicPhoto(sessionSlug, row) {
  const sharePath = `/${encodeURIComponent(sessionSlug)}/p/${encodeURIComponent(row.id)}`;
  const base = resolvePublicBaseUrl();
  return {
    id: row.id,
    variant: row.variant,
    mime: row.mime,
    bytes: row.bytes,
    sourceLocalName: row.source_local_name,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    canId: row.can_id || null,
    canLabel: row.can_label || null,
    url: `/media/${encodeURIComponent(sessionSlug)}/${encodeURIComponent(row.filename)}`,
    sharePath,
    shareUrl: `${base}${sharePath}`,
  };
}

export function publicSession(row, photos = []) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    eventDate: row.event_date,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    galleryUrl: `${resolvePublicBaseUrl()}/${encodeURIComponent(row.slug)}`,
    photos: photos.map((p) => publicPhoto(row.slug, p)),
  };
}
