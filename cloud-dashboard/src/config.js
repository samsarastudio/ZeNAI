import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
dotenv.config({ path: path.join(root, '.env') });

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function dataDirPath() {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
}

export function allowLocalPublicBaseUrl() {
  return String(process.env.ALLOW_LOCAL_PUBLIC_URL || '1').toLowerCase() === '1';
}

export function normalizePublicBaseUrl(raw) {
  const fallback = 'http://127.0.0.1:3020';
  return String(raw || fallback).trim().replace(/\/$/, '') || fallback;
}

export function isLocalPublicBaseUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return true;
  }
}

export const config = {
  root,
  port: intEnv('PORT', 3020),
  host: process.env.HOST || '0.0.0.0',
  get publicBaseUrl() {
    const envUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);
    if (!isLocalPublicBaseUrl(envUrl) || allowLocalPublicBaseUrl()) return envUrl;
    return envUrl;
  },
  uploadToken: process.env.UPLOAD_TOKEN || 'zyn-upload',
  adminPin: process.env.ADMIN_PIN || '2727',
  defaultTtlDays: intEnv('DEFAULT_TTL_DAYS', 30),
  dataDir: dataDirPath(),
  get dbPath() {
    return path.join(this.dataDir, 'zyn-cloud.sqlite');
  },
  get photosDir() {
    return path.join(this.dataDir, 'photos');
  },
  get boothUpdatesDir() {
    return path.join(this.dataDir, 'booth-updates');
  },
  get settingsPath() {
    return path.join(this.dataDir, 'settings.json');
  },
  publicDir: path.join(root, 'public'),
};
