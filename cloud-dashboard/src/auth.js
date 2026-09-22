import { config } from './config.js';
import { loadSettings } from './db.js';

export function getUploadToken() {
  try {
    const s = loadSettings();
    if (typeof s.uploadToken === 'string' && s.uploadToken.trim()) return s.uploadToken.trim();
  } catch {
    /* first boot */
  }
  return String(config.uploadToken || '').trim();
}

export function getDisplayToken() {
  try {
    const s = loadSettings();
    if (typeof s.displayToken === 'string' && s.displayToken.trim()) return s.displayToken.trim();
  } catch {
    /* first boot */
  }
  return 'zyn-display';
}

function tokenFromReq(req) {
  const header = req.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  return bearer || req.get('x-moments-token') || String(req.query?.token || '');
}

export function requireUploadToken(req, res, next) {
  const expected = getUploadToken();
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'UPLOAD_TOKEN not configured on server' });
  }
  if (tokenFromReq(req) !== expected) {
    return res.status(401).json({ ok: false, error: 'Invalid upload token' });
  }
  return next();
}

export function requireDisplayOrUploadToken(req, res, next) {
  const got = tokenFromReq(req);
  if (got && (got === getDisplayToken() || got === getUploadToken())) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

export function requireAdminPin(req, res, next) {
  const pin = req.get('x-admin-pin') || req.body?.pin || '';
  if (!pin || pin !== config.adminPin) {
    return res.status(401).json({ ok: false, error: 'Invalid admin PIN' });
  }
  return next();
}
