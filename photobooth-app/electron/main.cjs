const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { pathToFileURL, URL } = require('url');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const readline = require('readline');
const {
  readLocalVersion,
  canSelfUpdate,
  pollAndApply,
} = require('./booth-update.cjs');
const {
  initSelphyUsb,
  probeSelphyUsb,
  repairSelphyUsb,
} = require('./selphy-usb.cjs');
const { createJobPipeline } = require('./job-pipeline.cjs');
const { startDisplayApi } = require('./display-api.cjs');

const execFileAsync = promisify(execFile);

app.setName('ZYN Photobooth');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.zyn.photobooth.aicore');
}

let jobPipeline = null;

/**
 * Writable data beside the portable launcher (config, capture, user themes).
 * Portable .exe unpacks to %TEMP% each run — use PORTABLE_EXECUTABLE_DIR so
 * settings persist next to the launcher the user placed.
 */
function getPortableRoot() {
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir && typeof portableDir === 'string' && portableDir.trim()) {
      return portableDir.trim();
    }
    return path.dirname(app.getPath('exe'));
  }
  return path.join(__dirname, '..');
}

/** Shipped app files (themes, default config, bridge) — the unpacked exe directory. */
function getBundleRoot() {
  if (app.isPackaged) {
    return path.dirname(app.getPath('exe'));
  }
  return path.join(__dirname, '..');
}

if (process.env.PORTABLE_EXECUTABLE_DIR) {
  const dataDir = path.join(process.env.PORTABLE_EXECUTABLE_DIR.trim(), 'data');
  app.setPath('userData', dataDir);
  app.setPath('sessionData', dataDir);
}

function getConfigDir() {
  return path.join(getPortableRoot(), 'config');
}

function getLogsDir() {
  const dir = path.join(getPortableRoot(), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function getLogFilePath() {
  return path.join(getLogsDir(), 'photobooth.log');
}

const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Local file logger — works fully offline. Writes next to the portable exe:
 *   <exe folder>/logs/photobooth.log
 */
function appendAppLog(level, scope, message, detail, opts = {}) {
  const ts = new Date().toISOString();
  const lvl = String(level || 'info').toLowerCase();
  const sc = scope || 'app';
  const msg = message || '';
  let detailStr = '';
  try {
    const logPath = getLogFilePath();
    let line = `[${ts}] [${lvl.toUpperCase()}] [${sc}] ${msg}`;
    if (detail !== undefined && detail !== null && detail !== '') {
      let extra = detail;
      if (typeof detail === 'object') {
        try {
          extra = JSON.stringify(detail);
        } catch (_) {
          extra = String(detail);
        }
      }
      detailStr = String(extra);
      line += ` | ${detailStr}`;
    }
    line += '\n';
    try {
      const st = fs.existsSync(logPath) ? fs.statSync(logPath) : null;
      if (st && st.size > LOG_MAX_BYTES) {
        const buf = fs.readFileSync(logPath);
        const keep = buf.subarray(Math.floor(buf.length / 2));
        const cut = keep.indexOf(0x0a);
        const trimmed = cut >= 0 ? keep.subarray(cut + 1) : keep;
        fs.writeFileSync(logPath, trimmed);
      }
    } catch (_) {}
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (e) {
    try {
      console.error('[log-write-failed]', e);
    } catch (_) {}
  }
  if (!opts.skipBroadcast) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:log-entry', {
          ts,
          level: lvl,
          scope: sc,
          message: msg,
          detail: detailStr || undefined,
        });
      }
    } catch (_) {}
  }
}

process.on('uncaughtException', (err) => {
  appendAppLog('error', 'main', 'uncaughtException', String(err?.stack || err));
});
process.on('unhandledRejection', (reason) => {
  appendAppLog('error', 'main', 'unhandledRejection', String(reason?.stack || reason));
});

function getUserThemesDir() {
  const dir = path.join(getPortableRoot(), 'themes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getBundledThemesDir() {
  return path.join(getBundleRoot(), 'themes');
}

/** User-installed themes (admin zip uploads). */
function getThemesDir() {
  return getUserThemesDir();
}

function listThemeSearchRoots() {
  const roots = [];
  const bundled = getBundledThemesDir();
  const user = getUserThemesDir();
  if (fs.existsSync(bundled)) roots.push(bundled);
  if (user !== bundled && fs.existsSync(user)) roots.push(user);
  return roots;
}

function getBrandingDir() {
  return path.join(getConfigDir(), 'branding');
}

function getBrandingLogoAbsPath() {
  const cfg = loadMergedConfig();
  const name = cfg.branding && typeof cfg.branding.logoFile === 'string' ? cfg.branding.logoFile : null;
  if (!name) return null;
  const safe = path.basename(name);
  if (safe !== name || safe.includes('..')) return null;
  return path.join(getBrandingDir(), safe);
}

function getAiBrandLogoAbsPath() {
  const cfg = loadMergedConfig();
  const name =
    cfg.branding && typeof cfg.branding.aiLogoFile === 'string' ? cfg.branding.aiLogoFile : null;
  if (!name) return null;
  const safe = path.basename(name);
  if (safe !== name || safe.includes('..')) return null;
  return path.join(getBrandingDir(), safe);
}

function getConfigDefaultPath() {
  const candidates = [
    path.join(getPortableRoot(), 'config', 'photobooth-config.default.json'),
    path.join(getBundleRoot(), 'config', 'photobooth-config.default.json'),
    path.join(__dirname, '..', 'config', 'photobooth-config.default.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[candidates.length - 1];
}

function getConfigPath() {
  return path.join(getConfigDir(), 'photobooth-config.json');
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(a[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readJsonSafe(p) {
  let text = fs.readFileSync(p, 'utf8');
  // Strip UTF-8 BOM (PowerShell Set-Content -Encoding utf8 writes one).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function ensureConfigFiles() {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = getConfigPath();
  if (!fs.existsSync(cfgPath)) {
    const def = getConfigDefaultPath();
    if (fs.existsSync(def)) {
      fs.copyFileSync(def, cfgPath);
    } else {
      fs.writeFileSync(cfgPath, '{}', 'utf8');
    }
  }
}

function loadMergedConfig() {
  ensureConfigFiles();
  const defaults = fs.existsSync(getConfigDefaultPath())
    ? readJsonSafe(getConfigDefaultPath())
    : {};
  const user = fs.existsSync(getConfigPath()) ? readJsonSafe(getConfigPath()) : {};
  return deepMerge(defaults, user);
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function expandZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`,
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
}

function findDirectoryContainingThemeJson(root) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    try {
      if (fs.existsSync(path.join(d, 'theme.json'))) return d;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory()) stack.push(path.join(d, ent.name));
      }
    } catch (_) {}
  }
  return null;
}

function sanitizeThemeId(id) {
  const s = String(id || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return s || 'imported';
}

/** Resolve folder on disk for a theme id or folder name (handles legacy `kia` → circuit). */
function resolveThemeDirectoryInRoot(root, themeId) {
  const raw = String(themeId || '').trim();
  if (!raw) return null;
  const normalized = raw === 'kia' ? 'circuit' : raw;
  const tryDirs = [path.join(root, normalized), path.join(root, sanitizeThemeId(normalized))];
  for (const d of tryDirs) {
    if (fs.existsSync(path.join(d, 'theme.json'))) return d;
  }
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const tj = path.join(root, ent.name, 'theme.json');
      if (!fs.existsSync(tj)) continue;
      try {
        const meta = readJsonSafe(tj);
        const mid = meta.id || ent.name;
        if (mid === normalized || ent.name === normalized || mid === raw) {
          return path.join(root, ent.name);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function resolveThemeDirectory(themeId) {
  for (const root of listThemeSearchRoots()) {
    const found = resolveThemeDirectoryInRoot(root, themeId);
    if (found) return found;
  }
  return null;
}

/**
 * Still + preview files. Dev: `<repo>/build/capture`. Packaged: `<folder of exe>/capture`.
 */
function getCaptureDir() {
  const fromEnv = process.env.PHOTOBOOTH_CAPTURE_DIR?.trim();
  if (fromEnv) {
    try {
      fs.mkdirSync(fromEnv, { recursive: true });
    } catch (_) {}
    return fromEnv;
  }
  const dir = app.isPackaged
    ? path.join(getPortableRoot(), 'capture')
    : path.join(__dirname, '..', 'build', 'capture');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function isPathUnder(filePath, parentDir) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(filePath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPathUnderOrEqual(filePath, parentDir) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(filePath));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function sanitizeModeId(id) {
  const s = String(id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '');
  return s || 'mode';
}

function getAiBackgroundsRoot() {
  return path.join(getPortableRoot(), 'config', 'ai-backgrounds');
}

function getPhotoFramesDir() {
  const dir = path.join(getPortableRoot(), 'config', 'photo-frames');
  fs.mkdirSync(dir, { recursive: true });
  // Seed from bundled defaults on first run
  const bundled = path.join(getBundleRoot(), 'config', 'photo-frames');
  if (fs.existsSync(bundled)) {
    try {
      for (const ent of fs.readdirSync(bundled, { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(ext)) continue;
        const dest = path.join(dir, ent.name);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(bundled, ent.name), dest);
        }
      }
    } catch (_) {}
  }
  return dir;
}

function listPhotoFrameFiles() {
  const dir = getPhotoFramesDir();
  const files = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      files.push(ent.name);
    }
  } catch (_) {}
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

/** Guest gallery, wall mosaic, and 6×4 print all use 3:2 (1.5). */
const GALLERY_FRAME_ASPECT = 1.5;
const GALLERY_FRAME_ASPECT_TOLERANCE = 0.04;

function describeImageAspect(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w < 1 || h < 1) {
    return { width: w, height: h, aspectRatio: null, fitsGallery: false };
  }
  const aspectRatio = Math.round((w / h) * 10000) / 10000;
  const fitsGallery =
    Math.abs(aspectRatio - GALLERY_FRAME_ASPECT) / GALLERY_FRAME_ASPECT <= GALLERY_FRAME_ASPECT_TOLERANCE;
  return { width: w, height: h, aspectRatio, fitsGallery };
}

async function readImageAspect(filePath) {
  try {
    const sharpMod = require('sharp');
    const m = await sharpMod(filePath).metadata();
    return describeImageAspect(m.width, m.height);
  } catch {
    return { width: 0, height: 0, aspectRatio: null, fitsGallery: false };
  }
}

/** Pure-black (or JPEG-near-black) photo-hole key. Decorative navy/hair is darker than this but not all-channel-low. */
const FRAME_HOLE_BLACK_MAX = 18;

function isChromaHolePixel(r, g, b, a, threshold) {
  if (a < 16) return true;
  return r <= threshold && g <= threshold && b <= threshold;
}

function floodFillHoleMask(data, width, height, channels, seedX, seedY, threshold) {
  const mask = new Uint8Array(width * height);
  const seedI = (seedY * width + seedX) * channels;
  if (!isChromaHolePixel(data[seedI], data[seedI + 1], data[seedI + 2], data[seedI + 3], threshold)) {
    return { mask, count: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  const stack = [seedY * width + seedX];
  mask[stack[0]] = 1;
  let count = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    const y = (p - x) / width;
    count += 1;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    const neighbors = [p - 1, p + 1, p - width, p + width];
    const valid = [x > 0, x < width - 1, y > 0, y < height - 1];
    for (let n = 0; n < 4; n++) {
      if (!valid[n]) continue;
      const np = neighbors[n];
      if (mask[np]) continue;
      const i = np * channels;
      if (!isChromaHolePixel(data[i], data[i + 1], data[i + 2], data[i + 3], threshold)) continue;
      mask[np] = 1;
      stack.push(np);
    }
  }
  return { mask, count, minX, minY, maxX, maxY };
}

function fallbackHoleRect(w, h) {
  return {
    left: Math.round(w * 0.06),
    top: Math.round(h * 0.08),
    width: Math.round(w * 0.62),
    height: Math.round(h * 0.72),
  };
}

function holeRectFromBounds(minX, minY, maxX, maxY, w, h) {
  const padX = Math.round((maxX - minX) * 0.01);
  const padY = Math.round((maxY - minY) * 0.01);
  return {
    left: Math.max(0, minX + padX),
    top: Math.max(0, minY + padY),
    width: Math.max(32, Math.min(w - minX, maxX - minX - padX * 2)),
    height: Math.max(32, Math.min(h - minY, maxY - minY - padY * 2)),
  };
}

/**
 * Build the overlay that sits on top of the guest photo.
 * Prefer the file's own alpha channel (real PNGs). Only chroma-key a painted
 * black rectangle when the file has no usable transparency (JPEG / opaque PNG).
 */
async function prepareFrameOverlay(sharpMod, framePath) {
  const meta = await sharpMod(framePath).metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;
  const { data, info } = await sharpMod(framePath).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const channels = info.channels || 4;
  const total = w * h;

  let alphaHoles = 0;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * channels + 3];
      if (a >= 16) continue;
      alphaHoles += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const hasUsableAlpha = meta.hasAlpha === true && alphaHoles > total * 0.05;
  if (hasUsableAlpha) {
    const hole = holeRectFromBounds(minX, minY, maxX, maxY, w, h);
    // Composite the original PNG — do not re-encode pixels or punch extra holes.
    const overlay = await sharpMod(framePath).ensureAlpha().png().toBuffer();
    return { hole, overlay, keyed: false };
  }

  const seeds = [[Math.floor(w / 2), Math.floor(h / 2)]];
  for (let y = Math.floor(h * 0.2); y < h * 0.8; y += Math.max(8, Math.floor(h / 20))) {
    for (let x = Math.floor(w * 0.2); x < w * 0.8; x += Math.max(8, Math.floor(w / 20))) {
      seeds.push([x, y]);
    }
  }
  let best = { mask: new Uint8Array(total), count: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const tried = new Uint8Array(total);
  for (const [sx, sy] of seeds) {
    const sp = sy * w + sx;
    if (tried[sp]) continue;
    const fill = floodFillHoleMask(data, w, h, channels, sx, sy, FRAME_HOLE_BLACK_MAX);
    if (fill.count > 0) {
      for (let p = 0; p < total; p++) {
        if (fill.mask[p]) tried[p] = 1;
      }
    }
    if (fill.count > best.count) best = fill;
  }

  const coverage = best.count / total;
  const hole =
    best.count < 80 || coverage < 0.08
      ? fallbackHoleRect(w, h)
      : holeRectFromBounds(best.minX, best.minY, best.maxX, best.maxY, w, h);

  if (best.count >= 80 && coverage >= 0.08) {
    for (let p = 0; p < total; p++) {
      if (best.mask[p]) data[p * channels + 3] = 0;
    }
  }

  const overlay = await sharpMod(data, { raw: { width: w, height: h, channels } })
    .png()
    .toBuffer();
  return { hole, overlay, keyed: true };
}

/**
 * Guest photo UNDER the frame overlay (frame artwork sits on top).
 * Caption sits ON the photo (lower third of the hole) with a soft brushstroke
 * behind it for contrast — drawn last so busy frame art cannot hide it.
 */
async function compositePhotoIntoFrame(
  sharpMod,
  framePath,
  photoPath,
  photoScale = 1,
  guestText = '',
  creditLine = '',
  crop = null,
) {
  const scale = Math.min(1, Math.max(0.5, Number(photoScale) || 1));
  const meta = await sharpMod(framePath).metadata();
  const fw = meta.width || 1;
  const fh = meta.height || 1;
  const { hole, overlay: frameOverlay } = await prepareFrameOverlay(sharpMod, framePath);
  // Fill the full hole; only shrink if an admin explicitly sets photoScale < 1
  const targetW = Math.max(8, Math.round(hole.width * scale));
  const targetH = Math.max(8, Math.round(hole.height * scale));
  const left = hole.left + Math.round((hole.width - targetW) / 2);
  const top = hole.top + Math.round((hole.height - targetH) / 2);

  const photoMeta = await sharpMod(photoPath).metadata();
  const pw = photoMeta.width || targetW;
  const ph = photoMeta.height || targetH;
  const box = computeRotatedCrop(pw, ph, targetW, targetH, crop);
  const photoBuf = await sharpMod(photoPath)
    .extract({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    })
    .resize(targetW, targetH, { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer();

  // Base matches hole fill — no visible gap when scale === 1
  const base = await sharpMod({
    create: {
      width: fw,
      height: fh,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([{ input: photoBuf, left, top }])
    .png()
    .toBuffer();

  let composed = await sharpMod(base)
    .composite([{ input: frameOverlay, left: 0, top: 0 }])
    .png()
    .toBuffer();

  const caption = typeof guestText === 'string' ? guestText.trim().slice(0, 80) : '';
  const credit = typeof creditLine === 'string' ? creditLine.trim().slice(0, 60) : '';
  if (caption || credit) {
    const style = getCaptionStyleFromConfig();
    const overlays = [];
    if (style.brush) {
      const brush = await buildCaptionBrushOverlay(sharpMod, fw, fh, caption, credit, style);
      if (brush) overlays.push(brush);
    }
    const textSvg = buildFrameCaptionSvg(fw, fh, caption, credit, style);
    overlays.push({ input: Buffer.from(textSvg), left: 0, top: 0 });
    composed = await sharpMod(composed).composite(overlays).png().toBuffer();
  }

  return composed;
}

/**
 * Physical-frame cut sheet: two portrait cells (cm), safe-area insets,
 * landscape capture rotated 90° into each cell, uniform scale (no stretch).
 */
function cmToPx(cm, dpi) {
  return Math.round((Number(cm) / 2.54) * dpi);
}

function mmToPx(mm, dpi) {
  return Math.round((Number(mm) / 25.4) * dpi);
}

function resolvePhysicalFrameLayoutPx(opts, dpi) {
  const cellW =
    opts.cellWidthCm != null
      ? cmToPx(opts.cellWidthCm, dpi)
      : Math.round((Number(opts.cellWidthIn) || 5.3 / 2.54) * dpi);
  const cellH =
    opts.cellHeightCm != null
      ? cmToPx(opts.cellHeightCm, dpi)
      : Math.round((Number(opts.cellHeightIn) || 7.8 / 2.54) * dpi);
  const pageW = mmToPx(148, dpi);
  const pageH = mmToPx(100, dpi);
  const leftoverW = pageW - cellW * 2;
  const leftoverH = pageH - cellH;
  const gap =
    leftoverW >= mmToPx(8, dpi)
      ? mmToPx(4, dpi)
      : Math.max(0, Math.round(leftoverW * 0.2));
  const marginX = Math.max(0, Math.round((leftoverW - gap) / 2));
  const marginY = Math.max(0, Math.round(leftoverH / 2));
  const innerPad =
    opts.innerPaddingMm != null ? mmToPx(opts.innerPaddingMm, dpi) : mmToPx(3, dpi);
  const safeTop = mmToPx(opts.safeInsetTopMm ?? 0.2, dpi);
  const safeBottom = mmToPx(opts.safeInsetBottomMm ?? 0.2, dpi);
  const safeLeft = mmToPx(opts.safeInsetLeftMm ?? 3, dpi);
  const safeRight = mmToPx(opts.safeInsetRightMm ?? 1, dpi);
  return {
    cellW,
    cellH,
    gap,
    marginX,
    marginY,
    pageW,
    pageH,
    innerPad,
    safeTop,
    safeBottom,
    safeLeft,
    safeRight,
  };
}

function clampPhysicalCrop(crop) {
  const z = Number(crop?.zoom ?? crop?.cropZoom);
  const x = Number(crop?.panX ?? crop?.cropPanX);
  const y = Number(crop?.panY ?? crop?.cropPanY);
  return {
    zoom: Number.isFinite(z) ? Math.min(4, Math.max(1, z)) : 1,
    panX: Number.isFinite(x) ? Math.min(1, Math.max(-1, x)) : 0,
    panY: Number.isFinite(y) ? Math.min(1, Math.max(-1, y)) : 0,
  };
}

function computeRotatedCrop(rw, rh, safeW, safeH, crop) {
  const { zoom, panX, panY } = clampPhysicalCrop(crop);
  const srcW = Math.max(1, rw);
  const srcH = Math.max(1, rh);
  const destW = Math.max(1, safeW);
  const destH = Math.max(1, safeH);
  const cover = Math.max(destW / srcW, destH / srcH);
  const scale = cover * zoom;
  const safeAr = destW / destH;
  let visW = Math.min(srcW, destW / scale);
  let visH = Math.min(srcH, destH / scale);
  if (visW / visH > safeAr) visW = visH * safeAr;
  else visH = visW / safeAr;
  visW = Math.min(srcW, Math.max(1, visW));
  visH = Math.min(srcH, Math.max(1, visH));
  const maxL = Math.max(0, srcW - visW);
  const maxT = Math.max(0, srcH - visH);
  const left = Math.round(Math.min(maxL, Math.max(0, maxL / 2 + panX * (maxL / 2))));
  const top = Math.round(Math.min(maxT, Math.max(0, maxT / 2 + panY * (maxT / 2))));
  const width = Math.max(1, Math.min(Math.round(visW), srcW - left));
  const height = Math.max(1, Math.min(Math.round(visH), srcH - top));
  return { left, top, width, height };
}

/** Thin gold portrait border for physical-frame cells. */
function buildPhysicalCellBorderSvg(w, h, dpi) {
  const stroke = Math.max(1, Math.round(dpi / 180));
  const hair = Math.max(1, Math.round(dpi / 360));
  const inset = Math.max(stroke * 2, Math.round(dpi / 120));
  const x = inset;
  const y = inset;
  const bw = w - inset * 2;
  const bh = h - inset * 2;
  const inner = stroke + hair + 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="none" stroke="#8b7348" stroke-width="${stroke}" opacity="0.92"/>
  <rect x="${x + inner}" y="${y + inner}" width="${Math.max(1, bw - inner * 2)}" height="${Math.max(1, bh - inner * 2)}" fill="none" stroke="#dcc9a3" stroke-width="${hair}" opacity="0.78"/>
</svg>`;
}

async function fitPhotoInPhysicalSafeArea(sharpMod, photoPath, safeW, safeH, rotateDeg, crop) {
  const rot = Number(rotateDeg) === -90 ? -90 : 90;
  const inputBuf = fs.readFileSync(path.resolve(photoPath));
  const before = await sharpMod(inputBuf).metadata();
  // IMPORTANT: do NOT chain .rotate() (EXIF) before .rotate(angle) — Sharp ignores the angle.
  const rotated = await sharpMod(inputBuf)
    .rotate(rot, { background: { r: 255, g: 255, b: 255 } })
    .toBuffer();
  const rotMeta = await sharpMod(rotated).metadata();
  const rw = rotMeta.width || safeW;
  const rh = rotMeta.height || safeH;
  const box = computeRotatedCrop(rw, rh, safeW, safeH, crop);
  const buf = await sharpMod(rotated)
    .extract(box)
    .resize(safeW, safeH, { fit: 'fill' })
    .jpeg({ quality: 94, mozjpeg: true })
    .toBuffer();
  const after = await sharpMod(buf).metadata();
  appendAppLog('info', 'layouts', 'physical photo rotate+crop', {
    source: `${before.width}x${before.height}`,
    rotated: `${rw}x${rh}`,
    extract: box,
    fitted: `${after.width}x${after.height}`,
    safe: `${safeW}x${safeH}`,
    rotateDegrees: rot,
    crop: clampPhysicalCrop(crop),
  });
  return {
    buf,
    width: after.width || safeW,
    height: after.height || safeH,
  };
}

async function buildPhysicalFrameCell(sharpMod, photoPath, layout, rotate, borderEnabled, dpi, crop) {
  const { cellW, cellH, innerPad, safeTop, safeBottom, safeLeft, safeRight } = layout;
  const frameW = Math.max(8, cellW - innerPad * 2);
  const frameH = Math.max(8, cellH - innerPad * 2);
  const safeW = Math.max(8, frameW - safeLeft - safeRight);
  const safeH = Math.max(8, frameH - safeTop - safeBottom);

  const photo = await fitPhotoInPhysicalSafeArea(sharpMod, photoPath, safeW, safeH, rotate, crop);
  const photoLeft = innerPad + safeLeft + Math.round((safeW - photo.width) / 2);
  const photoTop = innerPad + safeTop + Math.round((safeH - photo.height) / 2);
  const composites = [{ input: photo.buf, left: photoLeft, top: photoTop }];

  if (borderEnabled) {
    composites.push({
      input: Buffer.from(buildPhysicalCellBorderSvg(frameW, frameH, dpi)),
      left: innerPad,
      top: innerPad,
    });
  }

  return sharpMod({
    create: {
      width: cellW,
      height: cellH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function compositePhysicalFrameDual(sharpMod, photoPath, opts = {}) {
  const dpi = Math.max(72, Math.min(600, Math.round(Number(opts.dpi) || 300)));
  const rotate = Number(opts.rotateDegrees) === -90 ? -90 : 90;
  const borderEnabled = opts.borderEnabled !== false;
  const crop = clampPhysicalCrop(opts);
  const layout = resolvePhysicalFrameLayoutPx(opts, dpi);
  const { cellW, cellH, gap, marginX, marginY, pageW, pageH } = layout;

  const photoCell = await buildPhysicalFrameCell(
    sharpMod,
    photoPath,
    layout,
    rotate,
    borderEnabled,
    dpi,
    crop,
  );

  const left0 = marginX;
  const left1 = marginX + cellW + gap;
  const top = marginY;

  appendAppLog('info', 'layouts', 'physical sheet 1:1 postcard', {
    page: `${pageW}x${pageH}`,
    cell: `${cellW}x${cellH}`,
    gap,
    marginX,
    marginY,
    crop,
  });

  return sharpMod({
    create: {
      width: pageW,
      height: pageH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      { input: photoCell, left: left0, top },
      { input: photoCell, left: left1, top },
    ])
    .png()
    .toBuffer();
}

function isPhysicalFrameLayoutPath(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  return /_physical\.(png|jpe?g|webp)$/.test(base);
}

function isFramedPrintPath(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  return /_framed\.(png|jpe?g|webp)$/.test(base);
}

function inferGalleryVariantFromPath(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (base.includes('_ai.') || base.endsWith('_ai.png')) return 'ai';
  if (base.includes('_physical.') || base.includes('_physical_')) return 'physical';
  if (base.includes('_framed.') || base.includes('_framed_')) return 'framed';
  return 'original';
}

function summarizeUploadQueue() {
  const items = loadUploadQueue().items || [];
  const summary = { uploadedOk: 0, queued: 0, pending: 0, error: 0, total: items.length };
  for (const item of items) {
    if (item.status === 'ok') summary.uploadedOk += 1;
    else if (item.status === 'pending') summary.pending += 1;
    else if (item.status === 'error') summary.error += 1;
    else summary.queued += 1;
  }
  summary.retryable = summary.queued + summary.pending + summary.error;
  return summary;
}

function prepareUploadQueueResync(payload = {}) {
  const q = loadUploadQueue();
  const base = galleryBaseUrl(payload?.apiBaseUrl);
  const token = String(payload?.uploadToken || '').trim();
  const eventPrefix = String(payload?.eventPrefix || 'session').trim() || 'session';
  const includeOk = !!payload?.includeOk;
  let requeued = 0;
  let skippedMissing = 0;
  const now = new Date().toISOString();

  for (const item of q.items) {
    if (base) item.apiBaseUrl = base;
    if (token) item.uploadToken = token;
    if (payload?.eventPrefix) item.eventPrefix = eventPrefix;

    if (item.status === 'ok' && !includeOk) continue;
    if (item.status !== 'ok' && item.status !== 'error' && item.status !== 'pending') continue;

    if (!item.filePath || !fs.existsSync(item.filePath)) {
      item.status = 'error';
      item.error = 'Photo file missing';
      item.updatedAt = now;
      skippedMissing += 1;
      notifyUploadQueueItem(item);
      continue;
    }

    item.status = 'queued';
    item.error = undefined;
    item.updatedAt = now;
    if (includeOk) {
      item.photoId = undefined;
      item.shareUrl = undefined;
      item.url = undefined;
      item.slug = undefined;
    }
    requeued += 1;
    notifyUploadQueueItem(item);
  }

  saveUploadQueue(q);
  return { requeued, skippedMissing };
}

function scanCaptureForQueue(payload = {}) {
  const captureRoot = getCaptureDir();
  if (!fs.existsSync(captureRoot)) return { discovered: 0 };

  const hasActive = (items, abs, variant) =>
    (items || []).some(
      (i) =>
        i.filePath === abs &&
        i.variant === variant &&
        (i.status === 'ok' || i.status === 'queued' || i.status === 'pending'),
    );

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let discovered = 0;
  for (const name of fs.readdirSync(captureRoot)) {
    const abs = path.resolve(path.join(captureRoot, name));
    if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
    const variant = inferGalleryVariantFromPath(abs);
    if (variant === 'original') {
      const physicalSibling = abs.replace(/\.(jpe?g|png|webp)$/i, '_physical.png');
      if (fs.existsSync(physicalSibling)) continue;
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size <= 0 || st.mtimeMs < cutoff) continue;

    if (hasActive(loadUploadQueue().items, abs, variant)) continue;
    enqueueGalleryUpload({ ...payload, filePath: abs, variant });
    discovered += 1;
  }
  return { discovered };
}

async function resyncUploadQueue(payload = {}) {
  const scan = scanCaptureForQueue(payload);
  const prep = prepareUploadQueueResync(payload);
  const before = summarizeUploadQueue();
  const flush = await flushUploadQueue();
  const after = summarizeUploadQueue();
  return {
    ok: true,
    ...flush,
    discovered: scan.discovered,
    requeued: prep.requeued,
    skippedMissing: prep.skippedMissing,
    before,
    after,
  };
}

/**
 * Canon SELPHY CP1500 postcard stock (KP-36IP / KP-108IN): 100.0 × 148.0 mm.
 * Marketing "6×4" is 152.4 × 101.6 mm — using that overscans the real paper and crops frames.
 */
const SELPHY_POSTCARD_W_MM = 148;
const SELPHY_POSTCARD_H_MM = 100;

function mmToPostcardPx(mm, dpi) {
  return Math.max(1, Math.round((Number(mm) / 25.4) * dpi));
}

/**
 * Physical sheets are already a 148×100 mm postcard at 1:1. Convert to JPEG
 * without shrinking — global bleed / crop inset must not change cell centimetres.
 */
async function preparePhysicalFramePrintRaster(sharpMod, imagePath, dpi = 300, _cropInsetMm = 0) {
  const pageW = mmToPostcardPx(SELPHY_POSTCARD_W_MM, dpi);
  const pageH = mmToPostcardPx(SELPHY_POSTCARD_H_MM, dpi);
  const meta = await sharpMod(imagePath).metadata();
  const fw = meta.width || pageW;
  const fh = meta.height || pageH;
  let input = imagePath;
  if (fw !== pageW || fh !== pageH) {
    const src = await sharpMod(imagePath)
      .resize(pageW, pageH, {
        fit: 'inside',
        withoutEnlargement: true,
        background: { r: 255, g: 255, b: 255 },
      })
      .png()
      .toBuffer();
    const sm = await sharpMod(src).metadata();
    const sw = sm.width || fw;
    const sh = sm.height || fh;
    const buf = await sharpMod({
      create: {
        width: pageW,
        height: pageH,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: src,
          left: Math.round((pageW - sw) / 2),
          top: Math.round((pageH - sh) / 2),
        },
      ])
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer();
    const tmp = path.join(os.tmpdir(), `pb-physical-print-${Date.now()}.jpg`);
    fs.writeFileSync(tmp, buf);
    return tmp;
  }
  const buf = await sharpMod(input)
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();
  const tmp = path.join(os.tmpdir(), `pb-physical-print-${Date.now()}.jpg`);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

/**
 * Digital framed composites must print the full artwork (result-screen view).
 * 3:2 frames (e.g. 1800×1200) are slightly wider than SELPHY 148×100 mm stock (1.48:1).
 * Uniform inset fills left/right but leaves the bottom short; borderless overscan then
 * clips the frame. Keep L/R at the admin inset, reserve extra mm at the bottom, and
 * top-align so leftover letterbox also sits on the trailing edge.
 */
async function prepareFramedPrintRaster(
  sharpMod,
  imagePath,
  dpi = 300,
  edgeInsetMm = 4,
  bottomExtraMm = 2.5,
) {
  const pageW = mmToPostcardPx(SELPHY_POSTCARD_W_MM, dpi);
  const pageH = mmToPostcardPx(SELPHY_POSTCARD_H_MM, dpi);
  const lr = mmToPostcardPx(Math.max(0, Number(edgeInsetMm) || 0), dpi);
  const extraBottom = mmToPostcardPx(Math.max(0, Number(bottomExtraMm) || 0), dpi);
  const innerW = Math.max(8, pageW - lr * 2);
  const innerH = Math.max(8, pageH - extraBottom);
  const fitted = await sharpMod(imagePath)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(innerW, innerH, {
      fit: 'inside',
      withoutEnlargement: false,
      background: { r: 255, g: 255, b: 255 },
    })
    .png()
    .toBuffer();
  const meta = await sharpMod(fitted).metadata();
  const fw = meta.width || innerW;
  const fh = meta.height || innerH;
  const buf = await sharpMod({
    create: {
      width: pageW,
      height: pageH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: fitted,
        left: lr + Math.round((innerW - fw) / 2),
        top: 0,
      },
    ])
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();
  const tmp = path.join(os.tmpdir(), `pb-framed-print-${Date.now()}.jpg`);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function windowsFontFileUrl(fileName) {
  const full = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', fileName);
  if (!fs.existsSync(full)) return null;
  return `file:///${full.replace(/\\/g, '/')}`;
}

function getCaptionBrushstrokePath() {
  const candidates = [
    path.join(getPortableRoot(), 'config', 'branding', 'caption-brushstroke.png'),
    path.join(getBundleRoot(), 'config', 'branding', 'caption-brushstroke.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function clampRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseHexColor(value, fallback) {
  const s = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  return fallback;
}

function hexLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function getCaptionStyleFromConfig() {
  const pf = (loadMergedConfig().photoFrames || {});
  const align =
    pf.guestTextAlign === 'left' || pf.guestTextAlign === 'right' ? pf.guestTextAlign : 'center';
  return {
    xPct: clampRange(pf.guestTextXPercent, 0, 100, 50),
    yPct: clampRange(pf.guestTextYPercent, 0, 100, 78),
    sizePct: clampRange(pf.guestTextSizePercent, 1.2, 12, 3.4),
    color: parseHexColor(pf.guestTextColor, '#c9a36a'),
    creditColor: parseHexColor(pf.guestTextCreditColor, '#d8c4a0'),
    align,
    brush: pf.guestTextBrush === true,
    brushOpacity: clampRange(pf.guestTextBrushOpacity, 0, 1, 0.22),
  };
}

function getCaptionLayout(fw, fh, guestText, creditLine, style) {
  const cx = fw * (style.xPct / 100);
  const cy = fh * (style.yPct / 100);
  const fontSize = Math.max(14, Math.round(fh * (style.sizePct / 100)));
  const creditSize = Math.max(9, Math.round(fontSize * 0.34));
  const guestY = creditLine ? cy - fontSize * 0.08 : cy + fontSize * 0.28;
  const creditY = guestY + fontSize * 0.52;
  const strokeW = Math.min(
    fw * 0.72,
    Math.max(fw * 0.18, fontSize * (1.8 + Math.min(28, (guestText || '').length) * 0.38)),
  );
  const strokeH = fontSize * (creditLine ? 1.85 : 1.45);
  const anchor = style.align === 'left' ? 'start' : style.align === 'right' ? 'end' : 'middle';
  return { cx, cy, fontSize, creditSize, guestY, creditY, strokeW, strokeH, anchor };
}

/**
 * Optional watercolor swipe — kept small and translucent when admin enables it.
 */
async function buildCaptionBrushOverlay(sharpMod, fw, fh, guestText, creditLine, style) {
  const brushPath = getCaptionBrushstrokePath();
  if (!brushPath) return null;
  const { cx, cy, strokeW } = getCaptionLayout(fw, fh, guestText, creditLine, style);
  const meta = await sharpMod(brushPath).metadata();
  const aspect = (meta.width || 1400) / Math.max(1, meta.height || 400);
  const targetW = Math.max(64, Math.round(strokeW));
  const targetH = Math.max(28, Math.round(targetW / aspect));
  const raw = await sharpMod(brushPath)
    .resize(targetW, targetH, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = raw.data;
  const mul = style.brushOpacity;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i + 3] = Math.round(pixels[i + 3] * mul);
  }
  const brushBuf = await sharpMod(pixels, {
    raw: { width: raw.info.width, height: raw.info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  let left = Math.round(cx - targetW / 2);
  if (style.align === 'left') left = Math.round(cx - targetW * 0.12);
  if (style.align === 'right') left = Math.round(cx - targetW * 0.88);
  return {
    input: brushBuf,
    left: Math.max(0, Math.min(fw - targetW, left)),
    top: Math.max(0, Math.round(cy - targetH / 2)),
  };
}

/**
 * Caption on the print. Thin contrasting outline instead of a large paint splash.
 */
function buildFrameCaptionSvg(fw, fh, guestText, creditLine, style) {
  const { cx, fontSize, creditSize, guestY, creditY, anchor } = getCaptionLayout(
    fw,
    fh,
    guestText,
    creditLine,
    style,
  );

  const scriptUrl =
    windowsFontFileUrl('segoesc.ttf') ||
    windowsFontFileUrl('FRSCRIPT.TTF') ||
    windowsFontFileUrl('SCRIPTBL.TTF') ||
    windowsFontFileUrl('segoepr.ttf');
  const serifUrl = windowsFontFileUrl('georgia.ttf') || windowsFontFileUrl('times.ttf');

  const fontFaces = [
    scriptUrl
      ? `@font-face{font-family:'PbCaptionScript';src:url('${scriptUrl}') format('truetype');}`
      : '',
    serifUrl
      ? `@font-face{font-family:'PbCaptionSerif';src:url('${serifUrl}') format('truetype');}`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const fill = style.color;
  const creditFill = style.creditColor;
  const outline = hexLuminance(fill) > 0.55 ? 'rgba(28,22,16,0.55)' : 'rgba(255,248,238,0.55)';
  const strokeW = Math.max(1.2, fontSize * 0.045);
  const guest = escapeXmlText(guestText);
  const credit = escapeXmlText(creditLine);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${fw}" height="${fh}" viewBox="0 0 ${fw} ${fh}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style type="text/css"><![CDATA[
      ${fontFaces}
      .guest-caption{font-family:'PbCaptionScript','Segoe Script','Segoe Print',Georgia,serif;font-size:${fontSize}px;fill:${fill};stroke:${outline};stroke-width:${strokeW}px;paint-order:stroke fill;}
      .guest-credit{font-family:'PbCaptionSerif',Georgia,'Times New Roman',serif;font-size:${creditSize}px;fill:${creditFill};opacity:0.92;}
    ]]></style>
  </defs>
  ${
    guest
      ? `<text x="${cx}" y="${guestY}" text-anchor="${anchor}" class="guest-caption">${guest}</text>`
      : ''
  }
  ${
    credit
      ? `<text x="${cx}" y="${creditY}" text-anchor="${anchor}" class="guest-credit">${credit}</text>`
      : ''
  }
</svg>`;
}

function getAiBackgroundsDir(modeId) {
  const dir = path.join(getAiBackgroundsRoot(), sanitizeModeId(modeId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackgroundImageFiles(modeId) {
  const dir = getAiBackgroundsDir(modeId);
  const files = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      files.push(ent.name);
    }
  } catch (_) {}
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

const DEFAULT_HEAD_FACE = {
  xPercent: 40,
  yPercent: 1,
  widthPercent: 17,
  heightPercent: 19,
};

/** Mild expand so hair is covered without blowing up head size vs the driver body. */
function expandFaceForHair(face) {
  const f = clampFace(face);
  const widthPercent = Math.min(28, Math.max(14, f.widthPercent * 1.12));
  const heightPercent = Math.min(30, Math.max(16, f.heightPercent * 1.28));
  const xPercent = Math.max(0, f.xPercent - (widthPercent - f.widthPercent) / 2);
  const yPercent = Math.max(0, f.yPercent - (heightPercent - f.heightPercent) * 0.55);
  return clampFace({ xPercent, yPercent, widthPercent, heightPercent });
}

function getCompositionsDir(modeId) {
  return path.join(getPortableRoot(), 'config', 'compositions', sanitizeModeId(modeId));
}

function getSharedCompositionsDir() {
  return path.join(getPortableRoot(), 'config', 'compositions', '_shared');
}

function clampFace(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const n = (v, fallback) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
  };
  const xPercent = Math.min(96, Math.max(0, n(o.xPercent, DEFAULT_HEAD_FACE.xPercent)));
  const yPercent = Math.min(96, Math.max(0, n(o.yPercent, DEFAULT_HEAD_FACE.yPercent)));
  const widthPercent = Math.min(80, Math.max(4, n(o.widthPercent, DEFAULT_HEAD_FACE.widthPercent)));
  const heightPercent = Math.min(80, Math.max(4, n(o.heightPercent, DEFAULT_HEAD_FACE.heightPercent)));
  return {
    xPercent,
    yPercent,
    widthPercent: Math.min(widthPercent, 100 - xPercent),
    heightPercent: Math.min(heightPercent, 100 - yPercent),
  };
}

function readFaceJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const f = j?.face || j;
    if (![f?.xPercent, f?.yPercent, f?.widthPercent, f?.heightPercent].every((v) => Number.isFinite(Number(v)))) {
      return null;
    }
    return clampFace(f);
  } catch (_) {
    return null;
  }
}

function listCompositionImageNames(dir) {
  const names = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!IMAGE_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) continue;
      names.push(ent.name);
    }
  } catch (_) {}
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

function pickCompositionFile(dir, names) {
  const pick =
    names.find((n) => /^composition\.jpe?g$/i.test(n)) ||
    names.find((n) => /^composition\.png$/i.test(n)) ||
    names.find((n) => /^composition\./i.test(n)) ||
    names[0];
  return pick ? path.join(dir, pick) : null;
}

/**
 * Each can has its own scene. Never borrow another can's image.
 * `_shared` is only a placeholder when that can folder has no file yet.
 */
function resolveCanComposition(modeId) {
  const id = sanitizeModeId(modeId);
  const canDir = getCompositionsDir(id);
  const canNames = listCompositionImageNames(canDir);
  if (canNames.length) {
    const imagePath = pickCompositionFile(canDir, canNames);
    return {
      canId: id,
      source: 'can',
      dir: canDir,
      imagePath,
      filename: path.basename(imagePath || ''),
    };
  }
  const sharedDir = getSharedCompositionsDir();
  const sharedNames = listCompositionImageNames(sharedDir);
  if (sharedNames.length) {
    const imagePath = pickCompositionFile(sharedDir, sharedNames);
    return {
      canId: id,
      source: 'shared',
      dir: sharedDir,
      imagePath,
      filename: path.basename(imagePath || ''),
    };
  }
  return null;
}

function loadCompositionFace(modeId, overrideFace) {
  const id = sanitizeModeId(modeId);
  const canFace = readFaceJson(path.join(getCompositionsDir(id), 'composition.json'));
  if (canFace) return expandFaceForHair(canFace);
  if (overrideFace && typeof overrideFace === 'object') {
    const clamped = clampFace(overrideFace);
    if (Number.isFinite(clamped.xPercent)) return expandFaceForHair(clamped);
  }
  const resolved = resolveCanComposition(id);
  if (resolved?.source === 'shared') {
    return expandFaceForHair(
      readFaceJson(path.join(resolved.dir, 'composition.json')) || { ...DEFAULT_HEAD_FACE },
    );
  }
  return expandFaceForHair({ ...DEFAULT_HEAD_FACE });
}

function writeCompositionMeta(modeId, face) {
  const id = sanitizeModeId(modeId);
  const dir = getCompositionsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'composition.json');
  let existing = {};
  try {
    if (fs.existsSync(filePath)) existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
  } catch (_) {
    existing = {};
  }
  const next = {
    ...existing,
    id,
    face: clampFace(face || existing.face || DEFAULT_HEAD_FACE),
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next.face;
}

function compositionPublic(modeId) {
  const resolved = resolveCanComposition(modeId);
  const face = loadCompositionFace(modeId);
  if (!resolved?.imagePath) {
    return { ok: true, canId: sanitizeModeId(modeId), url: null, source: null, filename: null, face };
  }
  return {
    ok: true,
    canId: resolved.canId,
    source: resolved.source,
    filename: resolved.filename,
    url: `${pathToFileURL(resolved.imagePath).href}?v=${Date.now()}`,
    face,
  };
}

function resolveAiBackgroundPath(modeId, filename) {
  const dir = getAiBackgroundsDir(modeId);
  const safe = path.basename(filename);
  if (!safe || safe !== filename || safe.includes('..')) return null;
  const full = path.join(dir, safe);
  if (!isPathUnderOrEqual(full, dir) || !fs.existsSync(full)) return null;
  return full;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024 - 8192;
const LANDSCAPE_SIZES = [
  [1536, 1024],
  [1440, 960],
  [1296, 864],
  [1152, 768],
  [1024, 682],
  [960, 640],
  [768, 512],
];

const PORTRAIT_SIZES = [
  [1024, 1536],
  [768, 1152],
  [682, 1024],
  [512, 768],
];

async function sceneIsPortrait(sharpMod, imagePath) {
  try {
    const meta = await sharpMod(imagePath).metadata();
    return (meta.height || 0) > (meta.width || 0);
  } catch (_) {
    return false;
  }
}

async function pngBufferUnderLimit(sharpMod, buildAtSize, sizes = LANDSCAPE_SIZES) {
  for (const [w, h] of sizes) {
    const candidate = await buildAtSize(w, h);
    if (candidate && candidate.length <= MAX_IMAGE_BYTES) {
      return candidate;
    }
  }
  return null;
}

async function prepareGuestHeadPng(sharpMod, absImage, outW, outH) {
  const meta = await sharpMod(absImage).metadata();
  const srcW = meta.width || outW;
  const srcH = meta.height || outH;
  // Include full beard / jaw / upper neck — prior 0.44 crop often cut facial hair.
  const cropW = Math.max(8, Math.round(srcW * 0.56));
  const cropH = Math.max(8, Math.round(srcH * 0.62));
  const left = Math.max(0, Math.round((srcW - cropW) / 2));
  const top = Math.max(0, Math.round(srcH * 0.01));
  const width = Math.min(cropW, srcW - left);
  const height = Math.min(cropH, srcH - top);
  return sharpMod(absImage)
    .extract({ left, top, width, height })
    .resize(outW, outH, { fit: 'cover', position: 'attention' })
    .ensureAlpha()
    .png({ compressionLevel: 9, effort: 8 })
    .toBuffer();
}

/**
 * Soft oval mask — long feather so no hard ring / outline remains after compositing.
 * `soft` = even longer falloff for the final paste onto the locked scene.
 */
async function ovalMaskPng(sharpMod, w, h, soft = false) {
  const feather = soft
    ? `<radialGradient id="g" cx="50%" cy="44%" r="68%">
        <stop offset="0%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="48%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="70%" stop-color="#fff" stop-opacity="0.55"/>
        <stop offset="88%" stop-color="#fff" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>`
    : `<radialGradient id="g" cx="50%" cy="44%" r="64%">
        <stop offset="0%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="52%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="78%" stop-color="#fff" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>${feather}</defs>
    <rect width="100%" height="100%" fill="#000" fill-opacity="0"/>
    <ellipse cx="${w / 2}" cy="${h * 0.48}" rx="${w * 0.49}" ry="${h * 0.5}" fill="url(#g)"/>
  </svg>`;
  return sharpMod(Buffer.from(svg)).resize(w, h).png().toBuffer();
}

/** Softly cover the original driver head (fully covered by the smaller guest paste). */
async function eraseOriginalHead(sharpMod, bgBuf, w, h, face) {
  const boxW = Math.max(24, Math.round((Number(face.widthPercent) / 100) * w));
  const boxH = Math.max(24, Math.round((Number(face.heightPercent) / 100) * h));
  // Erase slightly smaller than the upcoming guest paste so the cover never peeks past the feather.
  const eraseW = Math.round(boxW * 0.92);
  const eraseH = Math.round(boxH * 0.95);
  const cx = (Number(face.xPercent) / 100) * w + boxW / 2;
  const cy = (Number(face.yPercent) / 100) * h + boxH / 2;
  const left = Math.max(0, Math.min(w - eraseW, Math.round(cx - eraseW / 2)));
  const top = Math.max(0, Math.min(h - eraseH, Math.round(cy - eraseH / 2)));
  const sampleY = Math.min(h - 2, Math.round(cy + boxH * 0.55));
  const sampleX = Math.min(w - 2, Math.max(0, Math.round(cx)));
  let fill = { r: 40, g: 55, b: 70, alpha: 1 };
  try {
    const { data } = await sharpMod(bgBuf)
      .extract({ left: sampleX, top: sampleY, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (data?.length >= 3) fill = { r: data[0], g: data[1], b: data[2], alpha: 1 };
  } catch (_) {}
  const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${eraseW}" height="${eraseH}">
    <defs>
      <radialGradient id="e" cx="50%" cy="48%" r="62%">
        <stop offset="0%" stop-color="rgb(${fill.r},${fill.g},${fill.b})" stop-opacity="1"/>
        <stop offset="70%" stop-color="rgb(${fill.r},${fill.g},${fill.b})" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="rgb(${fill.r},${fill.g},${fill.b})" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="${eraseW / 2}" cy="${eraseH * 0.48}" rx="${eraseW * 0.48}" ry="${eraseH * 0.49}" fill="url(#e)"/>
  </svg>`;
  const cover = await sharpMod(Buffer.from(coverSvg)).png().toBuffer();
  return sharpMod(bgBuf)
    .composite([{ input: cover, left, top }])
    .ensureAlpha()
    .png()
    .toBuffer();
}

/** Place a proportionally smaller guest head on the driver — avoid oversized heads. */
async function buildHeadSwapComposite(sharpMod, backgroundPath, personPath, faceRegion) {
  const portrait = await sceneIsPortrait(sharpMod, backgroundPath);
  const sizes = portrait ? PORTRAIT_SIZES : LANDSCAPE_SIZES;
  return pngBufferUnderLimit(sharpMod, async (w, h) => {
    let bgBuf = await sharpMod(backgroundPath)
      .resize(w, h, { fit: 'cover', position: 'center' })
      .ensureAlpha()
      .toBuffer();
    const face = faceRegion || DEFAULT_HEAD_FACE;
    bgBuf = await eraseOriginalHead(sharpMod, bgBuf, w, h, face);
    const boxW = Math.max(24, Math.round((Number(face.widthPercent) / 100) * w));
    const boxH = Math.max(24, Math.round((Number(face.heightPercent) / 100) * h));
    // Scale down vs face box so the guest head matches F1 driver body proportions.
    const headW = Math.max(24, Math.round(boxW * 0.84));
    const headH = Math.max(24, Math.round(boxH * 0.9));
    const cx = (Number(face.xPercent) / 100) * w + boxW / 2;
    const cy = (Number(face.yPercent) / 100) * h + boxH / 2;
    const left = Math.max(0, Math.min(w - headW, Math.round(cx - headW / 2)));
    const top = Math.max(0, Math.min(h - headH, Math.round(cy - headH / 2 + headH * 0.04)));
    const headRaw = await prepareGuestHeadPng(sharpMod, personPath, headW, headH);
    const mask = await ovalMaskPng(sharpMod, headW, headH, false);
    const headBuf = await sharpMod(headRaw)
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
    return sharpMod(bgBuf)
      .composite([{ input: headBuf, left, top }])
      .ensureAlpha()
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
  }, sizes);
}

/**
 * Scene with driver head erased only — no oval guest paste.
 * GPT Image + mask + guest-face ref does the seamless replacement (cleaner than baking an oval).
 */
async function buildHeadEraseScene(sharpMod, backgroundPath, faceRegion) {
  const portrait = await sceneIsPortrait(sharpMod, backgroundPath);
  const sizes = portrait ? PORTRAIT_SIZES : LANDSCAPE_SIZES;
  return pngBufferUnderLimit(sharpMod, async (w, h) => {
    let bgBuf = await sharpMod(backgroundPath)
      .resize(w, h, { fit: 'cover', position: 'center' })
      .ensureAlpha()
      .toBuffer();
    bgBuf = await eraseOriginalHead(sharpMod, bgBuf, w, h, faceRegion || DEFAULT_HEAD_FACE);
    return sharpMod(bgBuf)
      .ensureAlpha()
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
  }, sizes);
}

/**
 * After GPT edits, lock the F1 body/scene and paste only a soft-feathered head
 * (no hard oval ring). Head paste is sized slightly under the face box for proportion.
 */
async function blendHeadOntoOriginalScene(sharpMod, scenePath, aiBuf, faceRegion) {
  const aiMeta = await sharpMod(aiBuf).metadata();
  const w = aiMeta.width || 1536;
  const h = aiMeta.height || 1024;
  let sceneBuf = await sharpMod(scenePath)
    .resize(w, h, { fit: 'cover', position: 'center' })
    .ensureAlpha()
    .toBuffer();
  const face = faceRegion || DEFAULT_HEAD_FACE;
  sceneBuf = await eraseOriginalHead(sharpMod, sceneBuf, w, h, face);
  const boxW = Math.max(24, Math.round((Number(face.widthPercent) / 100) * w));
  const boxH = Math.max(24, Math.round((Number(face.heightPercent) / 100) * h));
  // Extract a bit larger than paste so we have feather room, then paste smaller.
  const extractW = Math.max(48, Math.round(boxW * 1.05));
  const extractH = Math.max(48, Math.round(boxH * 1.1));
  const pasteW = Math.max(40, Math.round(boxW * 0.88));
  const pasteH = Math.max(40, Math.round(boxH * 0.94));
  const cx = (Number(face.xPercent) / 100) * w + boxW / 2;
  const cy = (Number(face.yPercent) / 100) * h + boxH / 2;
  const extractLeft = Math.max(0, Math.min(w - extractW, Math.round(cx - extractW / 2)));
  const extractTop = Math.max(0, Math.min(h - extractH, Math.round(cy - extractH / 2)));
  const mask = await ovalMaskPng(sharpMod, pasteW, pasteH, true);
  const headCrop = await sharpMod(aiBuf)
    .extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH })
    .resize(pasteW, pasteH, { fit: 'cover', position: 'centre' })
    .ensureAlpha()
    .toBuffer();
  const headBuf = await sharpMod(headCrop)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const pasteLeft = Math.max(0, Math.round(cx - pasteW / 2));
  const pasteTop = Math.max(0, Math.round(cy - pasteH / 2 + pasteH * 0.03));
  return sharpMod(sceneBuf)
    .composite([{ input: headBuf, left: pasteLeft, top: pasteTop }])
    .png({ compressionLevel: 9, effort: 8 })
    .toBuffer();
}

async function preparePersonPng(sharpMod, absImage) {
  return pngBufferUnderLimit(sharpMod, (w, h) =>
    sharpMod(absImage)
      .resize(w, h, {
        fit: 'contain',
        position: 'center',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .ensureAlpha()
      .png({ compressionLevel: 9, effort: 10, palette: true })
      .toBuffer(),
  );
}

async function buildInpaintComposite(sharpMod, backgroundPath, personPath, logoPath = null) {
  return pngBufferUnderLimit(sharpMod, async (w, h) => {
    const personMaxW = Math.round(w * 0.52);
    const personMaxH = Math.round(h * 0.72);
    let bgBuf = await sharpMod(backgroundPath)
      .resize(w, h, { fit: 'cover', position: 'center' })
      .ensureAlpha()
      .toBuffer();
    if (logoPath && fs.existsSync(logoPath)) {
      bgBuf = await overlayBrandLogosOnScene(sharpMod, bgBuf, w, h, logoPath);
    }
    const personBuf = await sharpMod(personPath)
      .resize(personMaxW, personMaxH, {
        fit: 'contain',
        position: 'south',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .ensureAlpha()
      .toBuffer();
    const personMeta = await sharpMod(personBuf).metadata();
    const pw = personMeta.width || personMaxW;
    const ph = personMeta.height || personMaxH;
    const left = Math.round((w - pw) / 2);
    const top = Math.round(h - ph - h * 0.06);
    const layers = [{ input: personBuf, left, top }];
    if (logoPath && fs.existsSync(logoPath)) {
      const accessoryLogo = await prepareBrandLogoPng(
        sharpMod,
        logoPath,
        Math.round(w * 0.09),
        Math.round(h * 0.07),
      );
      const accessoryMeta = await sharpMod(accessoryLogo).metadata();
      const aw = accessoryMeta.width || Math.round(w * 0.09);
      const ah = accessoryMeta.height || Math.round(h * 0.07);
      layers.push({
        input: accessoryLogo,
        left: Math.round(left + pw * 0.62),
        top: Math.round(top + ph * 0.08),
      });
      layers.push({
        input: accessoryLogo,
        left: Math.round(left + pw * 0.12),
        top: Math.round(top + ph * 0.42),
      });
    }
    return sharpMod(bgBuf)
      .composite(layers)
      .ensureAlpha()
      .png({ compressionLevel: 9, effort: 10, palette: true })
      .toBuffer();
  });
}

function getBrandContext(cfg) {
  const branding = cfg && cfg.branding && typeof cfg.branding === 'object' ? cfg.branding : {};
  const brandName =
    typeof branding.brandName === 'string' && branding.brandName.trim()
      ? branding.brandName.trim()
      : '';
  const applyBrandToAi = branding.applyBrandToAi !== false;
  const logoPath = getAiBrandLogoAbsPath();
  const hasLogo = !!(logoPath && fs.existsSync(logoPath));
  return {
    brandName,
    applyBrandToAi,
    logoPath: hasLogo ? logoPath : null,
    hasLogo,
  };
}

function applyBrandTokens(prompt, brandName) {
  const name = brandName && brandName.trim() ? brandName.trim() : 'the brand';
  return String(prompt || '').replace(/\{brand\}/gi, name);
}

async function prepareBrandLogoPng(sharpMod, logoPath, maxW, maxH) {
  return sharpMod(logoPath)
    .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: false })
    .ensureAlpha()
    .png({ compressionLevel: 9, effort: 6 })
    .toBuffer();
}

async function overlayBrandLogosOnScene(sharpMod, sceneBuf, w, h, logoPath) {
  const signLogo = await prepareBrandLogoPng(
    sharpMod,
    logoPath,
    Math.round(w * 0.24),
    Math.round(h * 0.13),
  );
  const signMeta = await sharpMod(signLogo).metadata();
  const boxLogo = await prepareBrandLogoPng(
    sharpMod,
    logoPath,
    Math.round(w * 0.15),
    Math.round(h * 0.1),
  );
  const boxMeta = await sharpMod(boxLogo).metadata();
  const boothLogo = await prepareBrandLogoPng(
    sharpMod,
    logoPath,
    Math.round(w * 0.11),
    Math.round(h * 0.08),
  );
  const boothMeta = await sharpMod(boothLogo).metadata();
  return sharpMod(sceneBuf)
    .composite([
      {
        input: signLogo,
        left: Math.round((w - (signMeta.width || 0)) / 2),
        top: Math.round(h * 0.04),
      },
      {
        input: boxLogo,
        left: Math.round(w * 0.05),
        top: Math.round(h * 0.54),
      },
      {
        input: boxLogo,
        left: Math.round(w - (boxMeta.width || 0) - w * 0.05),
        top: Math.round(h * 0.47),
      },
      {
        input: boothLogo,
        left: Math.round((w - (boothMeta.width || 0)) / 2),
        top: Math.round(h * 0.68),
      },
    ])
    .png()
    .toBuffer();
}

async function prepareLogoReferencePng(sharpMod, logoPath) {
  return pngBufferUnderLimit(sharpMod, (w, h) => {
    const side = Math.min(w, h, 768);
    return prepareBrandLogoPng(sharpMod, logoPath, side, side);
  });
}

const BRAND_LOGO_AI_SNIPPET =
  'Use the brand logo from the reference image(s) exactly — reproduce it on booth signage, product boxes, DJ equipment, headphones, and clothing where natural. Do not invent a different logo or mascot.';

/** OpenAI docs: Sunburst for precision edits; Flare/2 as fallbacks. */
const GPT_IMAGE_EDIT_MODELS = [
  'gpt-image-2.5-sunburst',
  'gpt-image-2',
  'gpt-image-1.5',
];

function gptImageEditQuality(model, preferMax = false) {
  // 2.5 family supports xhigh/max; gpt-image-2 / 1.5 use high.
  if (String(model || '').includes('2.5')) return preferMax ? 'max' : 'xhigh';
  return 'high';
}

function buildGptImageEditForm(
  FormData,
  sceneBuf,
  fullPrompt,
  extraImages = [],
  model = 'gpt-image-2.5-sunburst',
  size = '1536x1024',
  maskBuf = null,
  quality = null,
) {
  const form = new FormData();
  form.append('model', model);
  form.append('image[]', sceneBuf, { filename: 'scene.png', contentType: 'image/png' });
  const extras = Array.isArray(extraImages) ? extraImages : extraImages ? [extraImages] : [];
  for (const extra of extras) {
    if (!extra?.buf) continue;
    form.append('image[]', extra.buf, {
      filename: extra.filename || 'ref.png',
      contentType: extra.contentType || 'image/png',
    });
  }
  if (maskBuf) {
    // Transparent = edit region; opaque = preserve (OpenAI images/edits mask).
    form.append('mask', maskBuf, { filename: 'mask.png', contentType: 'image/png' });
  }
  form.append('prompt', fullPrompt);
  form.append('n', '1');
  form.append('size', size);
  form.append('quality', quality || gptImageEditQuality(model));
  // input_fidelity is for gpt-image-1 / 1.5 only — omit on gpt-image-2+.
  if (!String(model || '').startsWith('gpt-image-2')) {
    form.append('input_fidelity', 'high');
  }
  return form;
}

function buildEditPrompt(rawPrompt, options = {}) {
  const { inpainting = false, brandName = '', hasLogoRef = false, forDalle2 = false } = options;
  let raw = applyBrandTokens(rawPrompt, brandName);
  const suffixParts = [];
  if (inpainting) {
    // OpenAI prompting guide: assign reference roles + list identity constraints to preserve.
    suffixParts.push(
      'Image 1 is the F1 scene to edit (head region only, per mask). Image 2 (guest-face.png) is the guest IDENTITY reference — copy that person exactly. CRITICAL IDENTITY LOCK: preserve exact facial features, skin tone, eye shape/color, nose, lips, jawline, freckles, wrinkles, and especially beard, mustache, goatee, stubble, and all facial hair exactly as in image 2 — do not clean-shave, thin, restyle, or invent facial hair. Match hair from image 2. Match guest head size to the original driver head — do not enlarge. Completely remove the old driver head/hair with no oval outline, halo, cutout edge, or mask ring. Blend the neck naturally into the suit collar. Body, crossed arms, suit, car, pit, and camera stay identical to image 1.',
    );
  } else {
    suffixParts.push(
      'Use the entire visible scene (letterboxed in the square). Transform the whole composition—do not output a tighter zoom or headshot crop unless the uploaded image already is.',
    );
  }
  if (hasLogoRef) {
    suffixParts.push(BRAND_LOGO_AI_SNIPPET);
  }
  const suffix = ` ${suffixParts.join(' ')}`;
  const newspaperHeadlineGuard =
    raw.toLowerCase().includes('newspaper') && !raw.toUpperCase().includes('HAPPENING NOW!')
      ? ' Ensure the primary newspaper masthead headline reads exactly: HAPPENING NOW!'
      : '';
  let fullPrompt = raw + newspaperHeadlineGuard + suffix;
  // 1000-char cap is DALL·E 2 only — never truncate GPT Image prompts.
  if (forDalle2 && fullPrompt.length > 1000) {
    fullPrompt = fullPrompt.slice(0, 1000);
  }
  return fullPrompt;
}

/**
 * Full-frame edit mask: transparent oval over the head (edit), opaque elsewhere (preserve).
 */
async function buildHeadEditMaskPng(sharpMod, w, h, faceRegion) {
  const face = faceRegion || DEFAULT_HEAD_FACE;
  const boxW = Math.max(24, Math.round((Number(face.widthPercent) / 100) * w));
  const boxH = Math.max(24, Math.round((Number(face.heightPercent) / 100) * h));
  const rx = Math.round(boxW * 0.52);
  const ry = Math.round(boxH * 0.55);
  const cx = (Number(face.xPercent) / 100) * w + boxW / 2;
  const cy = (Number(face.yPercent) / 100) * h + boxH / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="black"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="white"/>
  </svg>`;
  const { data, info } = await sharpMod(Buffer.from(svg))
    .resize(w, h)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4;
    rgba[p] = 0;
    rgba[p + 1] = 0;
    rgba[p + 2] = 0;
    // White = edit → transparent alpha; black = preserve → opaque.
    rgba[p + 3] = data[i] > 127 ? 0 : 255;
  }
  return sharpMod(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

async function callOpenAiImageEdit(
  apiKey,
  pngBuf,
  fullPrompt,
  httpsPostMultipart,
  FormData,
  extraImages = [],
  apiBase = 'https://api.openai.com/v1',
  size = '1536x1024',
  maskBuf = null,
  options = {},
) {
  const preferMax = !!options.preferMax;
  const onProgress =
    typeof options.onProgress === 'function' ? options.onProgress : null;
  const parseJsonSafe = (text) => {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  };
  const makeErr = (statusCode, json, text) =>
    json?.error?.message || json?.message || text.slice(0, 400) || `HTTP ${statusCode}`;

  const auth = { Authorization: `Bearer ${apiKey.trim()}` };
  const editsUrl = `${String(apiBase || 'https://api.openai.com/v1').replace(/\/$/, '')}/images/edits`;
  const gptModels = GPT_IMAGE_EDIT_MODELS;
  let json = null;
  let modelUsed = gptModels[0];
  let lastErr = 'GPT image edit failed.';

  for (const model of gptModels) {
    const qualities = String(model).includes('2.5')
      ? preferMax
        ? ['max', 'xhigh', 'high']
        : ['xhigh', 'high']
      : ['high'];
    let modelOk = false;
    for (const quality of qualities) {
      onProgress &&
        onProgress({
          phase: 'openai_request',
          label: `OpenAI ${model} (${quality})…`,
          progress: 55,
          model,
          quality,
        });
      const form = buildGptImageEditForm(
        FormData,
        pngBuf,
        fullPrompt,
        extraImages,
        model,
        size,
        maskBuf,
        quality,
      );
      const gptRes = await httpsPostMultipart(editsUrl, form, auth);
      const gptJson = parseJsonSafe(gptRes.body);
      if (gptRes.statusCode >= 200 && gptRes.statusCode < 300 && gptJson) {
        json = gptJson;
        modelUsed = model;
        modelOk = true;
        onProgress &&
          onProgress({
            phase: 'openai_response',
            label: `Received image from ${model}`,
            progress: 85,
            model,
            quality,
          });
        break;
      }
      lastErr = makeErr(gptRes.statusCode, gptJson, gptRes.body);
      appendAppLog('warn', 'openai', 'image edit attempt failed', {
        model,
        quality,
        error: lastErr,
      });
    }
    if (modelOk) break;
  }

  if (!json) {
    // DALL·E 2 edits: single image only (no reference-image array). Logo is already composited locally.
    onProgress &&
      onProgress({
        phase: 'openai_fallback',
        label: 'Falling back to dall-e-2…',
        progress: 60,
        model: 'dall-e-2',
      });
    const dallePrompt =
      fullPrompt.length > 1000 ? fullPrompt.slice(0, 1000) : fullPrompt;
    const form = new FormData();
    form.append('image', pngBuf, { filename: 'photo.png', contentType: 'image/png' });
    if (maskBuf) {
      form.append('mask', maskBuf, { filename: 'mask.png', contentType: 'image/png' });
    }
    form.append('prompt', dallePrompt);
    form.append('model', 'dall-e-2');
    form.append('n', '1');
    form.append('size', '1024x1024');
    form.append('response_format', 'b64_json');
    const d2Res = await httpsPostMultipart(editsUrl, form, auth);
    const d2Json = parseJsonSafe(d2Res.body);
    const d2Ok = d2Res.statusCode >= 200 && d2Res.statusCode < 300 && !!d2Json;
    if (!d2Ok) {
      const fallbackErr = makeErr(d2Res.statusCode, d2Json, d2Res.body);
      return {
        ok: false,
        error: `${lastErr} (GPT image edits failed; fallback dall-e-2 also failed: ${fallbackErr})`,
      };
    }
    json = d2Json;
    modelUsed = 'dall-e-2';
  }

  const entry = json.data && json.data[0];
  const b64 = entry && entry.b64_json;
  const imageUrl = entry && entry.url;
  let outBuf;
  if (b64) {
    outBuf = Buffer.from(b64, 'base64');
  } else if (imageUrl) {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      return { ok: false, error: 'Could not download generated image.' };
    }
    const ab = await imgRes.arrayBuffer();
    outBuf = Buffer.from(ab);
  } else {
    return { ok: false, error: 'No image data in API response.' };
  }
  return { ok: true, outBuf, model: modelUsed };
}

/**
 * POST multipart/form-data using Node https + form.pipe().
 * Electron/Node global fetch (undici) often corrupts the `form-data` stream and OpenAI returns
 * "failed to parse multipart/form-data".
 */
function httpsPostMultipart(urlString, form, authHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          ...authHeaders,
          ...form.getHeaders(),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    form.pipe(req);
  });
}

function httpsGet(urlString, authHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { ...authHeaders },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpsPostJson(urlString, jsonBody, authHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const body = JSON.stringify(jsonBody);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...authHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function findBridgeExecutable() {
  const portable = getPortableRoot();
  const bundle = getBundleRoot();
  const candidates = [
    path.join(portable, 'edsdk-bridge.exe'),
    path.join(bundle, 'edsdk-bridge.exe'),
    path.join(__dirname, 'edsdk-bridge.exe'),
    path.join(portable, 'resources', 'edsdk-bridge.exe'),
    path.join(bundle, 'resources', 'edsdk-bridge.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const NATIVE_CAMERA_FILES = ['edsdk-bridge.exe', 'EDSDK.dll', 'EdsImage.dll'];

/**
 * Copy Canon bridge + DLLs from the unpacked app bundle next to the portable
 * launcher (PORTABLE_EXECUTABLE_DIR) so they persist and load reliably.
 */
function ensureNativeCameraAssets() {
  const destRoot = getPortableRoot();
  const sources = [getBundleRoot(), path.join(__dirname, '..', 'bin'), __dirname];
  let copied = 0;
  for (const file of NATIVE_CAMERA_FILES) {
    const dest = path.join(destRoot, file);
    if (fs.existsSync(dest)) continue;
    let src = null;
    for (const root of sources) {
      const candidate = path.join(root, file);
      if (fs.existsSync(candidate)) {
        src = candidate;
        break;
      }
    }
    if (!src) {
      appendAppLog('warn', 'edsdk-bridge', `missing native file, cannot stage: ${file}`);
      continue;
    }
    try {
      fs.mkdirSync(destRoot, { recursive: true });
      fs.copyFileSync(src, dest);
      copied += 1;
      appendAppLog('info', 'edsdk-bridge', `staged ${file} → ${dest}`);
    } catch (e) {
      appendAppLog('error', 'edsdk-bridge', `failed staging ${file}`, String(e));
    }
  }
  const bridge = findBridgeExecutable();
  appendAppLog('info', 'edsdk-bridge', 'ensureNativeCameraAssets', {
    destRoot,
    copied,
    bridgeFound: !!bridge,
    bridgePath: bridge,
  });
  return bridge;
}

let mainWindow = null;
let bridgeProc = null;
let bridgeReadline = null;
const bridgeQueue = [];
/** Delayed full release after `close` — cancelled if another camera cmd arrives (close→init). */
let bridgeReleaseTimer = null;

function cancelBridgeRelease() {
  if (bridgeReleaseTimer) {
    clearTimeout(bridgeReleaseTimer);
    bridgeReleaseTimer = null;
  }
}

function scheduleBridgeRelease() {
  cancelBridgeRelease();
  bridgeReleaseTimer = setTimeout(() => {
    bridgeReleaseTimer = null;
    void (async () => {
      try {
        if (bridgeProc && !bridgeProc.killed) {
          await sendBridge({ cmd: 'shutdown' });
        }
      } catch (e) {
        appendAppLog('warn', 'edsdk-bridge', 'deferred shutdown', String(e));
      } finally {
        killBridge();
      }
    })();
  }, 800);
}

function killBridge() {
  cancelBridgeRelease();
  if (bridgeReadline) {
    try {
      bridgeReadline.close();
    } catch (_) {}
    bridgeReadline = null;
  }
  if (bridgeProc) {
    try {
      bridgeProc.kill();
    } catch (_) {}
    bridgeProc = null;
  }
  while (bridgeQueue.length) {
    const p = bridgeQueue.shift();
    try {
      p.reject(new Error('Bridge killed'));
    } catch (_) {}
  }
}

/** Orphan bridges hold the Canon USB lock and make the next session fail. */
function killOrphanBridgeProcesses() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('taskkill', ['/F', '/IM', 'edsdk-bridge.exe', '/T'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    appendAppLog('info', 'edsdk-bridge', 'cleared orphan edsdk-bridge.exe processes');
  } catch (_) {
    /* none running — taskkill exits non-zero */
  }
}

function ensureBridgeProcess() {
  if (bridgeProc && !bridgeProc.killed) return true;
  let exe = findBridgeExecutable();
  if (!exe) {
    ensureNativeCameraAssets();
    exe = findBridgeExecutable();
  }
  if (!exe) {
    appendAppLog('error', 'edsdk-bridge', 'edsdk-bridge.exe not found', {
      portableRoot: getPortableRoot(),
      bundleRoot: getBundleRoot(),
    });
    return false;
  }

  // Ensure no leftover bridge from a crashed/previous run owns the camera.
  killOrphanBridgeProcesses();

  appendAppLog('info', 'edsdk-bridge', 'spawning', { exe, cwd: path.dirname(exe) });
  const cwd = path.dirname(exe);
  bridgeProc = spawn(exe, [], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  bridgeReadline = readline.createInterface({ input: bridgeProc.stdout });

  bridgeReadline.on('line', (line) => {
    const pending = bridgeQueue.shift();
    if (!pending) return;
    try {
      const msg = JSON.parse(line);
      pending.resolve(msg);
    } catch (e) {
      pending.reject(new Error(line || String(e)));
    }
  });

  bridgeProc.stderr.on('data', (d) => {
    const text = d.toString();
    console.error('[edsdk-bridge]', text);
    appendAppLog('warn', 'edsdk-bridge', 'stderr', text.trim().slice(0, 500));
  });

  bridgeProc.on('exit', (code, signal) => {
    appendAppLog('warn', 'edsdk-bridge', 'process exited', { code, signal });
    bridgeProc = null;
    // Let a final stdout line resolve before rejecting leftovers (shutdown race).
    setImmediate(() => {
      if (bridgeReadline) {
        try {
          bridgeReadline.close();
        } catch (_) {}
        bridgeReadline = null;
      }
      while (bridgeQueue.length) {
        const p = bridgeQueue.shift();
        p.reject(new Error('Bridge exited'));
      }
    });
  });

  return true;
}

const BRIDGE_CMD_TIMEOUT_MS = 8000;

function sendBridge(jsonObj) {
  return new Promise((resolve) => {
    // Any live camera command cancels a pending idle release (e.g. close → init).
    if (jsonObj?.cmd !== 'shutdown') {
      cancelBridgeRelease();
    }
    if (!ensureBridgeProcess()) {
      resolve({ ok: false, err: 'NO_BRIDGE', msg: 'edsdk-bridge.exe not found next to app' });
      return;
    }
    let settled = false;
    const finish = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(msg);
    };
    const entry = {
      resolve: (msg) => finish(msg),
      reject: (err) =>
        finish({ ok: false, err: 'BRIDGE_ERROR', msg: String(err?.message || err) }),
    };
    const timer = setTimeout(() => {
      const idx = bridgeQueue.indexOf(entry);
      if (idx >= 0) bridgeQueue.splice(idx, 1);
      appendAppLog('error', 'edsdk-bridge', 'command timed out', {
        cmd: jsonObj?.cmd,
        timeoutMs: BRIDGE_CMD_TIMEOUT_MS,
      });
      finish({
        ok: false,
        err: 'BRIDGE_TIMEOUT',
        msg: `Camera SDK timed out (${jsonObj?.cmd || 'cmd'}, ${BRIDGE_CMD_TIMEOUT_MS}ms)`,
      });
    }, BRIDGE_CMD_TIMEOUT_MS);
    bridgeQueue.push(entry);
    try {
      const line = JSON.stringify(jsonObj);
      bridgeProc.stdin.write(line + '\n');
    } catch (e) {
      const idx = bridgeQueue.indexOf(entry);
      if (idx >= 0) bridgeQueue.splice(idx, 1);
      finish({ ok: false, err: 'BRIDGE_WRITE', msg: String(e) });
    }
  });
}

function resolveRendererIndex() {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'photobooth-app', 'browser', 'index.html'),
    path.join(__dirname, '..', 'dist', 'photobooth-app', 'index.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const wantDevServer = process.argv.includes('--dev-server');
  const distIndex = resolveRendererIndex();
  if (app.isPackaged) {
    if (!distIndex) {
      dialog.showErrorBox(
        'ZYN Photobooth',
        'This install is missing the packaged UI. Reinstall the Folder build.',
      );
      app.quit();
      return;
    }
    mainWindow.loadFile(distIndex);
    return;
  }
  if (wantDevServer || !distIndex) {
    mainWindow.loadURL('http://localhost:4200');
    return;
  }
  mainWindow.loadFile(distIndex);
}

app.whenReady().then(() => {
  ensureConfigFiles();
  getLogsDir();
  ensureNativeCameraAssets();
  appendAppLog('info', 'main', 'app ready', {
    packaged: app.isPackaged,
    portableRoot: getPortableRoot(),
    bundleRoot: getBundleRoot(),
    hasBridge: !!findBridgeExecutable(),
    bridgePath: findBridgeExecutable(),
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
  });
  // Tablets / Windows often need an explicit grant for getUserMedia.
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    appendAppLog('info', 'permissions', 'permission request', { permission });
    if (permission === 'media' || permission === 'camera' || permission === 'microphone') {
      callback(true);
      return;
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'camera' || permission === 'microphone';
  });
  createWindow();
  initSelphyUsb({ appendAppLog, getBundleRoot });
  if (!jobPipeline) {
    jobPipeline = createJobPipeline({
      getStorePath: () => path.join(getPortableRoot(), 'data', 'jobs.json'),
      getConfig: () => loadMergedConfig(),
      generateAi: (payload) => generateAiImage(payload),
      printPhoto: (payload) => printPhotoInternal(payload),
      uploadJob: uploadJobToCloud,
      reportStatus: pushBoothJobStatus,
      log: (level, scope, message, detail) => appendAppLog(level, scope, message, detail),
      onJobsUpdated: (summary) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', summary);
        }
      },
    });
  }
  jobPipeline.start();
  startDisplayApi({
    getConfig: () => loadMergedConfig(),
    listJobs: () => jobPipeline.listJobs(),
    log: (level, scope, message, detail) => appendAppLog(level, scope, message, detail),
  });
  // Frames + photo queue: never block window creation. Retry periodically so a
  // later network restore still drains the queue without guest interaction.
  void syncFramesOnStartup();
  setTimeout(() => {
    void flushUploadQueue().catch((e) =>
      appendAppLog('warn', 'gallery', 'startup queue flush failed', String(e)),
    );
  }, 2500);
  setInterval(() => {
    void flushUploadQueue().catch(() => {});
  }, 60 * 1000);
  setInterval(() => {
    void syncFramesOnStartup();
  }, 5 * 60 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killBridge();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => killBridge());

ipcMain.handle('app:getPaths', () => {
  const captureDir = getCaptureDir();
  const local = readLocalVersion(getPortableRoot(), getBundleRoot());
  return {
    portableRoot: getPortableRoot(),
    captureDir,
    themesDir: getThemesDir(),
    configPath: getConfigPath(),
    logsDir: getLogsDir(),
    logFile: getLogFilePath(),
    hasBridge: !!findBridgeExecutable(),
    appVersion: local.version,
    appBuildId: local.buildId,
    appChannel: local.channel,
    canSelfUpdate: canSelfUpdate(app, getPortableRoot()),
  };
});

ipcMain.handle('app:getVersion', () => {
  const local = readLocalVersion(getPortableRoot(), getBundleRoot());
  let electronVersion = '';
  try {
    electronVersion = String(app.getVersion() || '');
  } catch (_) {
    /* ignore */
  }
  return {
    ok: true,
    ...local,
    electronVersion,
    installRoot: getPortableRoot(),
    canSelfUpdate: canSelfUpdate(app, getPortableRoot()),
  };
});

ipcMain.handle('app:checkBoothUpdate', async (_e, payload) => {
  try {
    const apply = payload?.apply === true;
    return await pollAndApply({
      app,
      loadMergedConfig,
      getPortableRoot,
      getBundleRoot,
      appendAppLog,
      killBridge,
      apply,
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('app:log', async (_e, payload) => {
  try {
    const level = payload?.level || 'info';
    const scope = payload?.scope || 'renderer';
    const message = payload?.message || '';
    const detail = payload?.detail;
    appendAppLog(level, scope, message, detail, {
      skipBroadcast: payload?.skipBroadcast === true,
    });
    return { ok: true, logFile: getLogFilePath() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('app:readLogTail', async (_e, payload) => {
  try {
    const maxLines = Math.min(1000, Math.max(20, Number(payload?.maxLines) || 250));
    const logPath = getLogFilePath();
    if (!fs.existsSync(logPath)) {
      return { ok: true, lines: [], logFile: logPath };
    }
    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { ok: true, lines: lines.slice(-maxLines), logFile: logPath };
  } catch (e) {
    return { ok: false, error: String(e), lines: [] };
  }
});

ipcMain.handle('app:openLogsFolder', async () => {
  try {
    const { shell } = require('electron');
    const dir = getLogsDir();
    const err = await shell.openPath(dir);
    if (err) return { ok: false, error: err, path: dir };
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('app:openExternal', async (_e, url) => {
  try {
    const { shell } = require('electron');
    const raw = String(url || '').trim();
    if (!/^https?:\/\//i.test(raw)) {
      return { ok: false, error: 'Only http(s) URLs are allowed' };
    }
    await shell.openExternal(raw);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('camera:invoke', async (_e, cmd) => {
  const cmdName = cmd?.cmd || 'unknown';
  if (cmdName !== 'preview') {
    appendAppLog('info', 'camera', `invoke ${cmdName}`, cmd);
  }
  const res = await sendBridge(cmd);
  if (res && !res.ok && cmdName !== 'preview') {
    appendAppLog('error', 'camera', `${cmdName} failed`, {
      err: res.err,
      msg: res.msg,
    });
  }
  if (res && res.ok && cmd.cmd === 'preview' && res.path) {
    try {
      res.previewFileUrl = pathToFileURL(res.path).href;
    } catch (err) {
      res.previewFileUrl = null;
      res.readErr = String(err);
      appendAppLog('warn', 'camera', 'preview url failed', String(err));
    }
  }
  // After close, release the bridge once idle so Canon isn't held warm between guests.
  // Debounced + cancelled by the next cmd so close→init on capture open still works.
  if (cmdName === 'close' && res && res.ok) {
    scheduleBridgeRelease();
  }
  return res;
});

function fileMtimeMs(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? st.mtimeMs : 0;
  } catch {
    return 0;
  }
}

function listCaptureHistory(options = {}) {
  const limit = Math.min(5000, Math.max(1, Math.round(Number(options.limit) || 2000)));
  const maxAgeDays = Number(options.maxAgeDays);
  const cutoff =
    Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
      : 0;
  const captureRoot = getCaptureDir();
  if (!fs.existsSync(captureRoot)) return [];

  const items = [];
  for (const name of fs.readdirSync(captureRoot)) {
    if (!/^capture_.+\.jpe?g$/i.test(name)) continue;
    if (/_live_preview/i.test(name)) continue;
    const abs = path.resolve(path.join(captureRoot, name));
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size <= 0) continue;

    const base = name.replace(/\.jpe?g$/i, '');
    const framedPath = path.join(captureRoot, `${base}_framed.png`);
    const physicalPath = path.join(captureRoot, `${base}_physical.png`);
    const aiPath = path.join(captureRoot, `${base}_ai.png`);
    const framedMtime = fileMtimeMs(framedPath);
    const physicalMtime = fileMtimeMs(physicalPath);
    const aiMtime = fileMtimeMs(aiPath);
    const hasFramed = framedMtime > 0;
    const hasPhysical = physicalMtime > 0;
    const hasAi = aiMtime > 0;
    const latestMs = Math.max(st.mtimeMs, framedMtime, physicalMtime, aiMtime);
    if (cutoff && latestMs < cutoff) continue;

    let displayPath = abs;
    let layoutMode;
    let label = 'Photo';
    let kind = 'normal';
    if (hasPhysical) {
      displayPath = physicalPath;
      layoutMode = 'physicalFrame';
      label = 'Physical';
      kind = 'physical';
    } else if (hasAi) {
      displayPath = aiPath;
      label = 'AI';
    } else if (hasFramed) {
      displayPath = framedPath;
      label = 'Framed';
    }

    items.push({
      id: base,
      capturedAt: new Date(latestMs).toISOString(),
      originalPath: abs.replace(/\\/g, '/'),
      framedPath: hasFramed ? framedPath.replace(/\\/g, '/') : undefined,
      displayPath: displayPath.replace(/\\/g, '/'),
      printPath: displayPath.replace(/\\/g, '/'),
      layoutMode,
      kind,
      label,
      hasPhysical,
      hasFramed,
    });
  }

  items.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  return items.slice(0, limit);
}

function isCaptureHistoryId(id) {
  return /^capture_[0-9]+$/i.test(String(id || ''));
}

function deleteCaptureHistory(id) {
  if (!isCaptureHistoryId(id)) {
    throw new Error('Invalid capture id.');
  }
  const captureRoot = path.resolve(getCaptureDir());
  if (!fs.existsSync(captureRoot)) return [];
  const deleted = [];
  for (const name of fs.readdirSync(captureRoot)) {
    const match = name === `${id}.jpg` || name === `${id}.jpeg` || name.startsWith(`${id}_`);
    if (!match) continue;
    const abs = path.resolve(path.join(captureRoot, name));
    if (!isPathUnder(abs, captureRoot)) continue;
    try {
      fs.unlinkSync(abs);
      deleted.push(name);
    } catch (e) {
      appendAppLog('warn', 'capture', 'deleteHistory file failed', { name, error: String(e) });
    }
  }
  return deleted;
}

ipcMain.handle('capture:listHistory', async (_e, options) => {
  try {
    const photos = listCaptureHistory(options || {});
    return { ok: true, photos };
  } catch (e) {
    appendAppLog('error', 'capture', 'listHistory failed', String(e));
    return { ok: false, error: String(e), photos: [] };
  }
});

ipcMain.handle('capture:deleteHistory', async (_e, id) => {
  try {
    const deleted = deleteCaptureHistory(id);
    appendAppLog('info', 'capture', 'deleteHistory', { id, deleted });
    return { ok: true, deleted };
  } catch (e) {
    appendAppLog('error', 'capture', 'deleteHistory failed', String(e));
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('file:readBase64', async (_e, filePath) => {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
});

ipcMain.handle('file:readThumbBase64', async (_e, filePath, maxEdge) => {
  const abs = path.resolve(String(filePath || ''));
  const captureRoot = path.resolve(getCaptureDir());
  if (!isPathUnder(abs, captureRoot)) {
    throw new Error('Thumb path outside capture directory.');
  }
  const edge = Math.min(480, Math.max(80, Math.round(Number(maxEdge) || 240)));
  const sharpMod = require('sharp');
  const buf = await sharpMod(abs)
    .rotate()
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
});

ipcMain.handle('file:saveJpeg', async (_e, fullPath, base64Body) => {
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, Buffer.from(base64Body, 'base64'));
  return { ok: true, path: fullPath };
});

async function generateAiImage(payload) {
  const onProgress =
    typeof payload?.onProgress === 'function' ? payload.onProgress : null;
  const report = (phase, label, progress, extra = {}) => {
    try {
      onProgress && onProgress({ phase, label, progress, ...extra });
    } catch (_) {}
  };
  appendAppLog('info', 'openai', 'generateImage start', {
    modeId: payload?.modeId,
    useInpainting: !!payload?.useInpainting,
    hasPrompt: !!(payload && payload.prompt),
  });
  try {
    let sharpMod;
    let FormData;
    try {
      sharpMod = require('sharp');
      FormData = require('form-data');
    } catch (_dep) {
      appendAppLog('error', 'openai', 'missing sharp/form-data');
      return {
        ok: false,
        error: 'Server dependencies missing: run npm install sharp form-data in the app folder.',
      };
    }
    report('prepare', 'Preparing capture…', 5);
    const imagePath =
      payload && typeof payload.imagePath === 'string' ? payload.imagePath : '';
    const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : '';
    const modeId = payload && typeof payload.modeId === 'string' ? payload.modeId.trim() : '';
    const useInpainting = !!(payload && payload.useInpainting);
    const randomizeBackground = payload?.randomizeBackground !== false;
    const inpaintPrompt =
      payload && typeof payload.inpaintPrompt === 'string' ? payload.inpaintPrompt.trim() : '';
    if (!imagePath.trim() || !prompt.trim()) {
      return { ok: false, error: 'Missing image path or prompt.' };
    }
    const cfg = loadMergedConfig();
    const apiKey = cfg.openAiApiKey;
    const brand = getBrandContext(cfg);
    const useBrandLogo = brand.applyBrandToAi && brand.hasLogo;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return { ok: false, error: 'OpenAI API key not configured.' };
    }
    const captureRoot = path.resolve(getCaptureDir());
    const absImage = path.resolve(imagePath);
    if (!fs.existsSync(absImage)) {
      return { ok: false, error: 'Source image not found.' };
    }
    if (!isPathUnder(absImage, captureRoot)) {
      return { ok: false, error: 'Invalid image path.' };
    }

    let pngBuf = null;
    let backgroundUsed = null;
    let effectivePrompt = prompt;
    const extraImages = [];
    let scenePathForLock = null;
    let faceForLock = null;

    if (useInpainting && modeId) {
      report('compose', 'Building F1 scene + guest face ref…', 15);
      const resolved = resolveCanComposition(modeId);
      if (!resolved?.imagePath) {
        return {
          ok: false,
          error: `No composition image for "${modeId}". Drop this can's unique scene at config/compositions/${sanitizeModeId(modeId)}/composition.jpg.`,
        };
      }
      backgroundUsed = `${resolved.canId}/${resolved.filename} (${resolved.source})`;
      const face = loadCompositionFace(modeId, payload?.face);
      scenePathForLock = resolved.imagePath;
      faceForLock = face;
      // Erase driver head only — do not paste an oval guest cutout (that caused hard edges).
      pngBuf = await buildHeadEraseScene(sharpMod, resolved.imagePath, face);
      report('face_ref', 'Preparing guest identity reference…', 28);
      // Larger ref + beard-inclusive crop for likeness (OpenAI identity preservation).
      const faceRef = await prepareGuestHeadPng(sharpMod, absImage, 1024, 1024);
      extraImages.push({ buf: faceRef, filename: 'guest-face.png' });
      effectivePrompt = inpaintPrompt || prompt;
      appendAppLog('info', 'openai', 'head-swap composition', {
        canId: resolved.canId,
        source: resolved.source,
        file: resolved.filename,
        face,
        inputStyle: 'erase+mask+face-ref',
      });
    } else {
      report('compose', 'Preparing photo for edit…', 20);
      pngBuf = await preparePersonPng(sharpMod, absImage);
    }

    if (!pngBuf) {
      return { ok: false, error: 'Prepared PNG is still above 4 MB.' };
    }

    if (!useInpainting && useBrandLogo && brand.logoPath) {
      const logoRefBuf = await prepareLogoReferencePng(sharpMod, brand.logoPath);
      extraImages.push({ buf: logoRefBuf, filename: 'brand-logo-ref.png' });
    }

    const fullPrompt = buildEditPrompt(effectivePrompt, {
      inpainting: useInpainting,
      brandName: brand.brandName,
      hasLogoRef: extraImages.some((x) => x.filename === 'brand-logo-ref.png'),
    });
    const pngMeta = await sharpMod(pngBuf).metadata();
    const gptSize =
      (pngMeta.height || 0) > (pngMeta.width || 0) ? '1024x1536' : '1536x1024';
    let maskBuf = null;
    if (useInpainting && faceForLock) {
      report('mask', 'Building head edit mask…', 40);
      maskBuf = await buildHeadEditMaskPng(
        sharpMod,
        pngMeta.width || 1536,
        pngMeta.height || 1024,
        faceForLock,
      );
    }
    report('openai_request', 'Calling OpenAI Images edits…', 50);
    const editRes = await callOpenAiImageEdit(
      apiKey,
      pngBuf,
      fullPrompt,
      httpsPostMultipart,
      FormData,
      extraImages,
      String(cfg.openAiApiUrl || 'https://api.openai.com/v1').replace(/\/$/, '') ||
        'https://api.openai.com/v1',
      gptSize,
      maskBuf,
      {
        preferMax: useInpainting,
        onProgress: (p) =>
          report(p.phase || 'openai_request', p.label || 'OpenAI…', p.progress ?? 55, {
            model: p.model,
            quality: p.quality,
          }),
      },
    );
    if (!editRes.ok) {
      appendAppLog('error', 'openai', 'image edit failed', editRes.error);
      return { ok: false, error: editRes.error };
    }
    let outBuf = editRes.outBuf;
    // With gpt-image-2.5-sunburst + mask, trust the model seam more; only soft-lock body for older models.
    const trustAiSeam = String(editRes.model || '').includes('2.5');
    if (useInpainting && scenePathForLock && !trustAiSeam) {
      report('composite', 'Locking head onto original scene…', 90);
      outBuf = await blendHeadOntoOriginalScene(sharpMod, scenePathForLock, outBuf, faceForLock);
      appendAppLog('info', 'openai', 'head locked onto original scene', {
        face: faceForLock,
        model: editRes.model,
      });
    } else if (useInpainting && trustAiSeam) {
      appendAppLog('info', 'openai', 'using native model seam (no oval re-paste)', {
        model: editRes.model,
      });
    }
    report('save', 'Saving AI image…', 95);
    const dir = path.dirname(absImage);
    const base = path.basename(absImage, path.extname(absImage));
    const outPath = path.join(dir, `${base}_ai.png`);
    fs.writeFileSync(outPath, outBuf);
    appendAppLog('info', 'openai', 'generateImage ok', {
      model: editRes.model,
      outPath,
      inpainting: useInpainting,
    });
    report('done', 'AI complete', 100, { model: editRes.model });
    return {
      ok: true,
      path: outPath,
      model: editRes.model,
      backgroundUsed,
      inpainting: useInpainting,
      brandApplied: useBrandLogo,
    };
  } catch (e) {
    appendAppLog('error', 'openai', 'generateImage exception', String(e));
    return { ok: false, error: String(e) };
  }
}

ipcMain.handle('openai:generateImage', async (_e, payload) => generateAiImage(payload));

function configForRenderer(full) {
  if (!full || typeof full !== 'object') return full;
  const { adminPin: _omit, openAiApiKey: _key, ...rest } = full;
  const email = rest.email && typeof rest.email === 'object' ? { ...rest.email } : {};
  const sendgridKey = typeof email.apiKey === 'string' ? email.apiKey.trim() : '';
  delete email.apiKey;
  delete email.pass;
  return {
    ...rest,
    email: {
      ...email,
      provider: 'sendgrid',
      apiKeyConfigured: sendgridKey.length > 0,
    },
    openAiApiUrl: String(full.openAiApiUrl || 'https://api.openai.com/v1').replace(/\/$/, ''),
    openAiConfigured:
      typeof full.openAiApiKey === 'string' && full.openAiApiKey.trim().length > 0,
  };
}

ipcMain.handle('admin:getConfig', async () => {
  try {
    return { ok: true, config: configForRenderer(loadMergedConfig()) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:verifyPin', async (_e, pin) => {
  try {
    const full = loadMergedConfig();
    const expected = String(full.adminPin ?? '2727');
    return { ok: true, valid: expected === String(pin ?? '') };
  } catch (e) {
    return { ok: false, error: String(e), valid: false };
  }
});

ipcMain.handle('admin:saveConfig', async (_e, partial) => {
  try {
    ensureConfigFiles();
    const incoming = { ...(partial || {}) };
    if (incoming.email && typeof incoming.email === 'object') {
      const emailPatch = { ...incoming.email };
      if (!String(emailPatch.apiKey || '').trim()) {
        delete emailPatch.apiKey;
      }
      incoming.email = emailPatch;
    }
    const merged = deepMerge(loadMergedConfig(), incoming);
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
    return { ok: true, config: configForRenderer(merged) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:testOpenAiKey', async (_e, draftKey) => {
  try {
    const cfg = loadMergedConfig();
    const fromDraft = typeof draftKey === 'string' ? draftKey.trim() : '';
    const key = fromDraft || (typeof cfg.openAiApiKey === 'string' ? cfg.openAiApiKey.trim() : '');
    if (!key) {
      return { ok: false, error: 'No API key to test. Enter a key or save one first.' };
    }
    const base = String(cfg.openAiApiUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await httpsGet(`${base}/models`, {
      Authorization: `Bearer ${key}`,
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { ok: true, message: 'API key is valid.' };
    }
    let detail = res.body;
    try {
      const j = JSON.parse(res.body);
      detail = j.error?.message || j.message || res.body;
    } catch (_) {}
    return {
      ok: false,
      error: `HTTP ${res.statusCode}: ${String(detail).slice(0, 240)}`,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:listThemes', async () => {
  try {
    const byId = new Map();
    for (const root of listThemeSearchRoots()) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const name of entries) {
        if (!name.isDirectory()) continue;
        const tj = path.join(root, name.name, 'theme.json');
        if (!fs.existsSync(tj)) continue;
        try {
          const meta = readJsonSafe(tj);
          const id = meta.id || name.name;
          byId.set(id, {
            id,
            folder: name.name,
            name: meta.name || name.name,
            version: meta.version,
            author: meta.author,
            description: meta.description,
          });
        } catch (_) {}
      }
    }
    return { ok: true, themes: [...byId.values()] };
  } catch (e) {
    return { ok: false, error: String(e), themes: [] };
  }
});

ipcMain.handle('admin:getThemeStylesheetUrl', async () => {
  try {
    const cfg = loadMergedConfig();
    const raw = cfg.activeThemeId || 'default';
    const id = raw === 'kia' ? 'circuit' : raw;
    const themeDir = resolveThemeDirectory(id);
    if (!themeDir) return { ok: true, url: null };
    const cssPath = path.join(themeDir, 'styles.css');
    if (!fs.existsSync(cssPath)) return { ok: true, url: null };
    return { ok: true, url: pathToFileURL(cssPath).href };
  } catch (e) {
    return { ok: false, error: String(e), url: null };
  }
});

ipcMain.handle('admin:pickThemeZip', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showOpenDialog(win, {
    title: 'Select theme zip',
    properties: ['openFile'],
    filters: [{ name: 'Zip', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('admin:exportThemeZip', async (_e, themeId) => {
  try {
    const themeDir = resolveThemeDirectory(themeId);
    if (!themeDir || !fs.existsSync(themeDir)) {
      return { ok: false, error: 'Theme not found.' };
    }
    let meta = {};
    try {
      meta = readJsonSafe(path.join(themeDir, 'theme.json'));
    } catch (_) {}
    const slug = sanitizeThemeId(meta.id || path.basename(themeDir));
    const downloads = app.getPath('downloads');
    const out = path.join(downloads, `Photobooth-theme-${slug}.zip`);
    const glob = path.join(themeDir, '*');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path ${psQuote(glob)} -DestinationPath ${psQuote(out)} -Force`,
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:deleteTheme', async (_e, themeId) => {
  try {
    const themeDir = resolveThemeDirectory(themeId);
    if (!themeDir || !fs.existsSync(themeDir)) {
      return { ok: false, error: 'Theme not found.' };
    }
    const userThemes = getUserThemesDir();
    if (!isPathUnderOrEqual(themeDir, userThemes)) {
      return { ok: false, error: 'Cannot remove built-in themes.' };
    }
    const folderName = path.basename(themeDir);
    let meta = {};
    try {
      meta = readJsonSafe(path.join(themeDir, 'theme.json'));
    } catch (_) {}
    const deletedId = meta.id || folderName;

    ensureConfigFiles();
    const cfg = loadMergedConfig();
    let active = cfg.activeThemeId || 'default';
    if (active === 'kia') active = 'circuit';

    fs.rmSync(themeDir, { recursive: true, force: true });

    const activeMatches =
      active === deletedId ||
      active === folderName ||
      sanitizeThemeId(active) === sanitizeThemeId(deletedId);

    if (activeMatches) {
      const merged = deepMerge(loadMergedConfig(), { activeThemeId: 'default' });
      fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
      return { ok: true, removedId: deletedId, switchedActiveToDefault: true };
    }
    return { ok: true, removedId: deletedId, switchedActiveToDefault: false };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:installThemeFromZip', async (_e, zipPath) => {
  const tmp = path.join(app.getPath('temp'), `pb-theme-${Date.now()}`);
  try {
    expandZip(zipPath, tmp);
    const themeDir = findDirectoryContainingThemeJson(tmp);
    if (!themeDir) {
      return { ok: false, error: 'No theme.json found in archive.' };
    }
    const meta = readJsonSafe(path.join(themeDir, 'theme.json'));
    const id = sanitizeThemeId(meta.id);
    const dest = path.join(getUserThemesDir(), id);
    fs.mkdirSync(getUserThemesDir(), { recursive: true });
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(themeDir, dest, { recursive: true });
    const metaPath = path.join(dest, 'theme.json');
    const fixed = { ...meta, id };
    fs.writeFileSync(metaPath, JSON.stringify(fixed, null, 2), 'utf8');
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: true, id };
  } catch (e) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:pickLogoImage', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showOpenDialog(win, {
    title: 'Select booth logo',
    properties: ['openFile'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'],
      },
    ],
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('admin:installLogo', async (_e, sourcePath) => {
  try {
    if (!sourcePath || typeof sourcePath !== 'string' || !fs.existsSync(sourcePath)) {
      return { ok: false, error: 'Invalid source file.' };
    }
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
    const useExt = allowed.includes(ext) ? ext : '.png';
    const destName = `booth-logo${useExt}`;
    ensureConfigFiles();
    const brandingDir = getBrandingDir();
    fs.mkdirSync(brandingDir, { recursive: true });
    const dest = path.join(brandingDir, destName);
    try {
      const prev = getBrandingLogoAbsPath();
      if (prev && fs.existsSync(prev) && path.normalize(prev) !== path.normalize(dest)) {
        fs.unlinkSync(prev);
      }
    } catch (_) {}
    fs.copyFileSync(sourcePath, dest);
    const merged = deepMerge(loadMergedConfig(), {
      branding: { logoFile: destName },
    });
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
    const url = `${pathToFileURL(dest).href}?v=${Date.now()}`;
    return { ok: true, logoFile: destName, url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:clearLogo', async () => {
  try {
    ensureConfigFiles();
    const p = getBrandingLogoAbsPath();
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    const merged = deepMerge(loadMergedConfig(), {
      branding: { logoFile: null },
    });
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:getBrandingLogoUrl', async () => {
  try {
    const p = getBrandingLogoAbsPath();
    if (!p || !fs.existsSync(p)) return { ok: true, url: null };
    return { ok: true, url: `${pathToFileURL(p).href}?v=${Date.now()}` };
  } catch (e) {
    return { ok: false, error: String(e), url: null };
  }
});

ipcMain.handle('admin:pickAiLogoImage', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showOpenDialog(win, {
    title: 'Select AI brand reference logo',
    properties: ['openFile'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'],
      },
    ],
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('admin:installAiLogo', async (_e, sourcePath) => {
  try {
    if (!sourcePath || typeof sourcePath !== 'string' || !fs.existsSync(sourcePath)) {
      return { ok: false, error: 'Invalid source file.' };
    }
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
    const useExt = allowed.includes(ext) ? ext : '.png';
    const destName = `ai-brand-logo${useExt}`;
    ensureConfigFiles();
    const brandingDir = getBrandingDir();
    fs.mkdirSync(brandingDir, { recursive: true });
    const dest = path.join(brandingDir, destName);
    try {
      const prev = getAiBrandLogoAbsPath();
      if (prev && fs.existsSync(prev) && path.normalize(prev) !== path.normalize(dest)) {
        fs.unlinkSync(prev);
      }
    } catch (_) {}
    fs.copyFileSync(sourcePath, dest);
    const merged = deepMerge(loadMergedConfig(), {
      branding: { aiLogoFile: destName },
    });
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
    const url = `${pathToFileURL(dest).href}?v=${Date.now()}`;
    return { ok: true, aiLogoFile: destName, url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:clearAiLogo', async () => {
  try {
    ensureConfigFiles();
    const p = getAiBrandLogoAbsPath();
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    const merged = deepMerge(loadMergedConfig(), {
      branding: { aiLogoFile: null },
    });
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:getAiBrandLogoUrl', async () => {
  try {
    const p = getAiBrandLogoAbsPath();
    if (!p || !fs.existsSync(p)) return { ok: true, url: null };
    return { ok: true, url: `${pathToFileURL(p).href}?v=${Date.now()}` };
  } catch (e) {
    return { ok: false, error: String(e), url: null };
  }
});

ipcMain.handle('admin:listAiBackgrounds', async (_e, modeId) => {
  try {
    const id = sanitizeModeId(modeId);
    const files = listBackgroundImageFiles(id);
    const items = files.map((filename) => {
      const full = path.join(getAiBackgroundsDir(id), filename);
      return {
        filename,
        url: `${pathToFileURL(full).href}?v=${Date.now()}`,
      };
    });
    return { ok: true, modeId: id, backgrounds: items };
  } catch (e) {
    return { ok: false, error: String(e), backgrounds: [] };
  }
});

ipcMain.handle('admin:getComposition', async (_e, canId) => {
  try {
    return compositionPublic(canId);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:listCompositions', async () => {
  try {
    const cfg = loadMergedConfig();
    const fromCfg = (Array.isArray(cfg.cans) ? cfg.cans : []).map((c) => c && c.id).filter(Boolean);
    const defaults = ['cool-mint', 'wintergreen', 'peppermint', 'spearmint', 'cinnamon', 'citrus'];
    const ids = [...new Set([...fromCfg, ...defaults])];
    const items = ids.map((id) => compositionPublic(id));
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: String(e), items: [] };
  }
});

ipcMain.handle('admin:pickCompositionImage', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showOpenDialog(win, {
    title: 'Select this can\'s F1 scene (unique composition)',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('admin:installComposition', async (_e, canId, sourcePath) => {
  try {
    if (!sourcePath || typeof sourcePath !== 'string' || !fs.existsSync(sourcePath)) {
      return { ok: false, error: 'Invalid source file.' };
    }
    const id = sanitizeModeId(canId);
    const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const useExt = allowed.includes(ext) ? ext : '.jpg';
    const dir = getCompositionsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of listCompositionImageNames(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (_) {}
    }
    const dest = path.join(dir, `composition${useExt === '.jpeg' ? '.jpg' : useExt}`);
    fs.copyFileSync(sourcePath, dest);
    const existingFace = readFaceJson(path.join(dir, 'composition.json'));
    writeCompositionMeta(id, existingFace || DEFAULT_HEAD_FACE);
    appendAppLog('info', 'composition', 'installed can scene', { canId: id, dest });
    return compositionPublic(id);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:saveCompositionFace', async (_e, canId, face) => {
  try {
    const saved = writeCompositionMeta(canId, face);
    return { ok: true, canId: sanitizeModeId(canId), face: saved };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('frames:list', async () => {
  try {
    const files = listPhotoFrameFiles();
    const dir = getPhotoFramesDir();
    const frames = await Promise.all(
      files.map(async (filename) => {
        const full = path.join(dir, filename);
        const label = filename
          .replace(/\.[^.]+$/, '')
          .replace(/[-_]+/g, ' ')
          .trim();
        const size = await readImageAspect(full);
        return {
          filename,
          label,
          url: `${pathToFileURL(full).href}?v=${Date.now()}`,
          ...size,
        };
      }),
    );
    return { ok: true, frames };
  } catch (e) {
    return { ok: false, error: String(e), frames: [] };
  }
});

ipcMain.handle('frames:apply', async (_e, payload) => {
  try {
    let sharpMod;
    try {
      sharpMod = require('sharp');
    } catch (_dep) {
      return { ok: false, error: 'sharp is not available.' };
    }
    const imagePath =
      payload && typeof payload.imagePath === 'string' ? payload.imagePath.trim() : '';
    const frameFile =
      payload && typeof payload.frameFile === 'string' ? path.basename(payload.frameFile.trim()) : '';
    const photoScale =
      payload && typeof payload.photoScale === 'number' ? payload.photoScale : 1;
    const guestText =
      payload && typeof payload.guestText === 'string' ? payload.guestText : '';
    const creditLine =
      payload && typeof payload.creditLine === 'string' ? payload.creditLine : '';
    const crop = {
      zoom: payload?.cropZoom ?? payload?.zoom,
      panX: payload?.cropPanX ?? payload?.panX,
      panY: payload?.cropPanY ?? payload?.panY,
    };
    if (!imagePath || !frameFile) {
      return { ok: false, error: 'Missing image or frame.' };
    }
    if (!fs.existsSync(imagePath)) {
      return { ok: false, error: 'Source photo not found.' };
    }
    const framePath = path.join(getPhotoFramesDir(), frameFile);
    if (!fs.existsSync(framePath)) {
      return { ok: false, error: `Frame not found: ${frameFile}` };
    }
    appendAppLog('info', 'frames', 'apply start', {
      imagePath,
      frameFile,
      photoScale,
      hasGuestText: !!guestText.trim(),
      cropZoom: crop.zoom,
      cropPanX: crop.panX,
      cropPanY: crop.panY,
    });
    const outBuf = await compositePhotoIntoFrame(
      sharpMod,
      framePath,
      imagePath,
      photoScale,
      guestText,
      creditLine,
      crop,
    );
    const dir = path.dirname(imagePath);
    const base = path.basename(imagePath, path.extname(imagePath));
    const outPath = path.join(dir, `${base}_framed.png`);
    fs.writeFileSync(outPath, outBuf);
    const now = new Date();
    try {
      fs.utimesSync(outPath, now, now);
    } catch {
      /* mtime from writeFile is enough */
    }
    appendAppLog('info', 'frames', 'apply ok', { outPath });
    return { ok: true, path: outPath, frameFile };
  } catch (e) {
    appendAppLog('error', 'frames', 'apply failed', String(e));
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('layouts:physicalFrameDual', async (_e, payload) => {
  try {
    let sharpMod;
    try {
      sharpMod = require('sharp');
    } catch (_dep) {
      return { ok: false, error: 'sharp is not available.' };
    }
    const imagePath =
      payload && typeof payload.imagePath === 'string' ? payload.imagePath.trim() : '';
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { ok: false, error: 'Source photo not found.' };
    }
    const cfg = loadMergedConfig()?.physicalFrame || {};
    const opts = {
      cellWidthCm: payload?.cellWidthCm ?? cfg.cellWidthCm,
      cellHeightCm: payload?.cellHeightCm ?? cfg.cellHeightCm,
      innerPaddingMm: payload?.innerPaddingMm ?? cfg.innerPaddingMm,
      safeInsetTopMm: payload?.safeInsetTopMm ?? cfg.safeInsetTopMm,
      safeInsetBottomMm: payload?.safeInsetBottomMm ?? cfg.safeInsetBottomMm,
      safeInsetLeftMm: payload?.safeInsetLeftMm ?? cfg.safeInsetLeftMm,
      safeInsetRightMm: payload?.safeInsetRightMm ?? cfg.safeInsetRightMm,
      gapMm: payload?.gapMm ?? cfg.gapMm,
      marginMm: payload?.marginMm ?? cfg.marginMm,
      cellWidthIn: payload?.cellWidthIn ?? cfg.cellWidthIn,
      cellHeightIn: payload?.cellHeightIn ?? cfg.cellHeightIn,
      gapIn: payload?.gapIn ?? cfg.gapIn,
      marginIn: payload?.marginIn ?? cfg.marginIn,
      dpi: payload?.dpi ?? cfg.dpi,
      rotateDegrees: payload?.rotateDegrees ?? cfg.rotateDegrees,
      borderEnabled: payload?.borderEnabled ?? cfg.borderEnabled,
      cropZoom: payload?.cropZoom ?? payload?.zoom,
      cropPanX: payload?.cropPanX ?? payload?.panX,
      cropPanY: payload?.cropPanY ?? payload?.panY,
      zoom: payload?.cropZoom ?? payload?.zoom,
      panX: payload?.cropPanX ?? payload?.panX,
      panY: payload?.cropPanY ?? payload?.panY,
    };
    appendAppLog('info', 'layouts', 'physicalFrameDual start', { imagePath, ...opts });
    const outBuf = await compositePhysicalFrameDual(sharpMod, imagePath, opts);
    const dir = path.dirname(imagePath);
    const base = path.basename(imagePath, path.extname(imagePath));
    const outPath = path.join(dir, `${base}_physical.png`);
    fs.writeFileSync(outPath, outBuf);
    appendAppLog('info', 'layouts', 'physicalFrameDual ok', { outPath });
    return { ok: true, path: outPath };
  } catch (e) {
    appendAppLog('error', 'layouts', 'physicalFrameDual failed', String(e));
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:pickPhotoFrameImage', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showOpenDialog(win, {
    title: 'Select photo frame PNG',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('admin:installPhotoFrame', async (_e, sourcePath) => {
  try {
    if (!sourcePath || typeof sourcePath !== 'string' || !fs.existsSync(sourcePath)) {
      return { ok: false, error: 'Invalid source file.' };
    }
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const useExt = allowed.includes(ext) ? ext : '.png';
    const base =
      path
        .basename(sourcePath, path.extname(sourcePath))
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '') || `frame-${Date.now()}`;
    const destName = `${base}${useExt}`;
    const dest = path.join(getPhotoFramesDir(), destName);
    fs.copyFileSync(sourcePath, dest);
    const size = await readImageAspect(dest);
    return {
      ok: true,
      filename: destName,
      url: `${pathToFileURL(dest).href}?v=${Date.now()}`,
      ...size,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:deletePhotoFrame', async (_e, filename) => {
  try {
    const safe = path.basename(String(filename || ''));
    if (!safe || safe.includes('..')) return { ok: false, error: 'Invalid filename.' };
    const full = path.join(getPhotoFramesDir(), safe);
    if (!isPathUnderOrEqual(full, getPhotoFramesDir())) {
      return { ok: false, error: 'Invalid path.' };
    }
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return { ok: true, removed: safe };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:pickAiBackgroundImage', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showOpenDialog(win, {
    title: 'Select AI background image',
    properties: ['openFile'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp'],
      },
    ],
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('admin:installAiBackground', async (_e, modeId, sourcePath) => {
  try {
    if (!sourcePath || typeof sourcePath !== 'string' || !fs.existsSync(sourcePath)) {
      return { ok: false, error: 'Invalid source file.' };
    }
    const id = sanitizeModeId(modeId);
    const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const useExt = allowed.includes(ext) ? ext : '.jpg';
    const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9-_]/g, '_');
    const destName = `${base || 'background'}_${Date.now()}${useExt}`;
    const dir = getAiBackgroundsDir(id);
    const dest = path.join(dir, destName);
    fs.copyFileSync(sourcePath, dest);
    return {
      ok: true,
      modeId: id,
      filename: destName,
      url: `${pathToFileURL(dest).href}?v=${Date.now()}`,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:deleteAiBackground', async (_e, modeId, filename) => {
  try {
    const full = resolveAiBackgroundPath(modeId, filename);
    if (!full) {
      return { ok: false, error: 'Background file not found.' };
    }
    fs.unlinkSync(full);
    return { ok: true, removed: path.basename(full) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('admin:exportThemeTemplate', async () => {
  try {
    const src = path.join(getBundleRoot(), 'theme-template');
    if (!fs.existsSync(src)) {
      return { ok: false, error: 'theme-template folder not found next to app.' };
    }
    const downloads = app.getPath('downloads');
    const out = path.join(downloads, 'Photobooth-theme-template.zip');
    const glob = path.join(src, '*');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path ${psQuote(glob)} -DestinationPath ${psQuote(out)} -Force`,
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

function galleryBaseUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/$/, '');
}

/** Rewrite Pi-local or wrong-port share links to the booth's configured gallery host. */
function normalizeGalleryPublicUrl(url, apiBaseUrl) {
  if (!url || !apiBaseUrl) return url;
  try {
    const u = new URL(String(url));
    const base = new URL(
      String(apiBaseUrl).endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`,
    );
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    const sameHost = u.hostname === base.hostname;
    if (!local && !sameHost) return url;
    const path = `${u.pathname}${u.search}${u.hash}`;
    return new URL(path, `${base.protocol}//${base.host}`).toString();
  } catch (_) {
    /* keep original */
  }
  return url;
}

async function galleryFetchJson(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  return { res, data };
}

ipcMain.handle('gallery:ensureDaySession', async (_e, payload) => {
  try {
    const base = galleryBaseUrl(payload?.apiBaseUrl);
    const token = String(payload?.uploadToken || '').trim();
    const eventPrefix = String(payload?.eventPrefix || 'session').trim() || 'session';
    if (!base || !token) {
      return { ok: false, error: 'Gallery API URL and upload token are required.' };
    }
    const { res, data } = await galleryFetchJson(`${base}/api/sessions/day`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ eventPrefix }),
    });
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error || `HTTP ${res.status}` };
    }
    return {
      ok: true,
      slug: data.session?.slug,
      galleryUrl: data.session?.galleryUrl,
      expiresAt: data.session?.expiresAt,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

function getUploadQueuePath() {
  const dir = path.join(getPortableRoot(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'gallery-upload-queue.json');
}

function loadUploadQueue() {
  try {
    const p = getUploadQueuePath();
    if (!fs.existsSync(p)) return { items: [] };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { items: Array.isArray(raw?.items) ? raw.items : [] };
  } catch (_) {
    return { items: [] };
  }
}

/** Merge by id so a flush in progress cannot wipe items enqueued concurrently. */
function saveUploadQueue(q) {
  const disk = loadUploadQueue();
  const map = new Map();
  for (const it of disk.items || []) {
    if (it?.id) map.set(it.id, it);
  }
  for (const it of q.items || []) {
    if (!it?.id) continue;
    const prev = map.get(it.id);
    if (!prev) {
      map.set(it.id, it);
      continue;
    }
    const prevT = Date.parse(prev.updatedAt || prev.createdAt || '') || 0;
    const nextT = Date.parse(it.updatedAt || it.createdAt || '') || 0;
    // Prefer the caller’s copy when timestamps are equal/newer (in-memory flush updates).
    map.set(it.id, nextT >= prevT ? { ...prev, ...it } : { ...it, ...prev });
  }
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const items = [...map.values()].filter((it) => {
    if (it.status !== 'ok') return true;
    const t = Date.parse(it.updatedAt || it.createdAt || '') || 0;
    return t >= cutoff;
  });
  fs.writeFileSync(getUploadQueuePath(), JSON.stringify({ items }, null, 2), 'utf8');
}

function notifyUploadQueueItem(item) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const payload =
        item?.shareUrl && item?.apiBaseUrl
          ? {
              ...item,
              shareUrl: normalizeGalleryPublicUrl(item.shareUrl, item.apiBaseUrl),
            }
          : item;
      mainWindow.webContents.send('gallery:upload-queue-updated', payload);
    }
  } catch (_) {}
}

function isLikelyOfflineError(err) {
  const s = String(err || '');
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|offline|AbortError|getaddrinfo|Failed to fetch/i.test(
    s,
  );
}

/** Fast probe so a downed Moments host does not burn 20s per queued photo. */
async function galleryReachable(base, timeoutMs = 2500) {
  if (!base) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Prefer frames (also used for frame sync); fall back to health.
    let res = await fetch(`${base}/api/frames`, { signal: ac.signal });
    if (res.ok) return true;
    res = await fetch(`${base}/api/health`, { signal: ac.signal });
    return !!res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function uploadPhotoOnce(payload, signal) {
  const base = galleryBaseUrl(payload?.apiBaseUrl);
  const token = String(payload?.uploadToken || '').trim();
  const eventPrefix = String(payload?.eventPrefix || 'session').trim() || 'session';
  const variant = String(payload?.variant || 'original');
  const filePath = String(payload?.filePath || '');
  if (!base || !token) {
    return { ok: false, error: 'Gallery API URL and upload token are required.' };
  }
  if (!filePath) return { ok: false, error: 'Missing filePath' };
  const abs = path.resolve(filePath);
  const captureRoot = path.resolve(getCaptureDir());
  if (!isPathUnder(abs, captureRoot)) {
    return { ok: false, error: 'Photo path outside capture directory.' };
  }
  if (!fs.existsSync(abs)) return { ok: false, error: 'Photo file not found.' };

  const ensure = await galleryFetchJson(
    `${base}/api/sessions/day`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ eventPrefix }),
      signal,
    },
  );
  if (!ensure.res.ok || !ensure.data?.ok) {
    return { ok: false, error: ensure.data?.error || `Session HTTP ${ensure.res.status}` };
  }
  const slug = ensure.data.session?.slug;
  if (!slug) return { ok: false, error: 'No session slug returned' };

  const FormData = require('form-data');
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const form = new FormData();
  form.append('photo', buf, {
    filename: path.basename(abs),
    contentType: mime,
    knownLength: buf.length,
  });
  form.append('variant', variant);
  form.append('sourceLocalName', path.basename(abs));
  if (payload?.guestEmail) form.append('guestEmail', String(payload.guestEmail));
  if (payload?.canId) form.append('canId', String(payload.canId));
  if (payload?.canLabel) form.append('canLabel', String(payload.canLabel));
  if (payload?.capturedAt) form.append('capturedAt', String(payload.capturedAt));
  if (payload?.jobId) form.append('jobId', String(payload.jobId));

  const uploadUrl = `${base}/api/sessions/${encodeURIComponent(slug)}/photos`;
  const bodyBuf = form.getBuffer();
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
      'Content-Length': String(bodyBuf.length),
    },
    body: bodyBuf,
    signal,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok || !data?.ok) {
    return { ok: false, error: data?.error || `Upload HTTP ${res.status}` };
  }
  return {
    ok: true,
    slug,
    photoId: data.photo?.id,
    shareUrl: normalizeGalleryPublicUrl(data.photo?.shareUrl, base),
    url: data.photo?.url,
    variant: data.photo?.variant,
    emailStatus: data.emailStatus || data.photo?.emailStatus,
    emailError: data.emailError || data.photo?.emailError,
  };
}

async function uploadJobToCloud(job, cfg) {
  const g = cfg?.gallery || {};
  const base = {
    apiBaseUrl: g.apiBaseUrl,
    uploadToken: g.uploadToken,
    eventPrefix: g.sessionPrefix || 'zyn',
    guestEmail: job.email,
    canId: job.canId,
    canLabel: job.canLabel,
    capturedAt: job.createdAt || null,
    jobId: job.id || null,
  };
  // ZYN flow: cloud + print only receive the finished AI image (never the raw capture).
  if (g.uploadAi === false) return { ok: true, skipped: true };
  if (!job.aiPath) return { ok: false, error: 'AI image not ready for upload.' };
  return uploadPhotoOnce({ ...base, filePath: job.aiPath, variant: 'ai' });
}

async function pushBoothJobStatus(job) {
  try {
    const cfg = loadMergedConfig();
    const g = cfg?.gallery || {};
    const base = galleryBaseUrl(g.apiBaseUrl);
    const token = String(g.uploadToken || '').trim();
    if (!base || !token || !job?.id) return { ok: false, skipped: true };
    const url = `${base}/api/booth-jobs/${encodeURIComponent(job.id)}`;
    const body = {
      canId: job.canId || null,
      canLabel: job.canLabel || null,
      aiStatus: job.aiStatus || 'queued',
      aiPhase: job.aiPhase || null,
      aiPhaseLabel: job.aiPhaseLabel || null,
      aiProgress: Number.isFinite(job.aiProgress) ? job.aiProgress : null,
      aiModel: job.aiModel || null,
      printStatus: job.printStatus || 'idle',
      uploadStatus: job.uploadStatus || 'idle',
      lastError: job.lastError || null,
      photoId: job.cloudPhotoId || null,
      createdAt: job.createdAt || null,
    };
    const { res, data } = await galleryFetchJson(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

let uploadFlushRunning = false;
/** Set when enqueue happens while a flush is in progress — run another pass. */
let uploadFlushAgain = false;

async function flushUploadQueuePass() {
  // Always reload so items enqueued during a prior pass are included.
  const q = loadUploadQueue();
  let uploaded = 0;
  let failed = 0;
  let stoppedOffline = false;
  const pendingItems = (q.items || []).filter((i) => i.status !== 'ok' && i.status !== 'error');
  if (pendingItems.length) {
    const base = galleryBaseUrl(pendingItems[0].apiBaseUrl);
    if (base && !(await galleryReachable(base, 2500))) {
      appendAppLog('warn', 'gallery', 'queue flush skipped — Moments unreachable', {
        pending: pendingItems.length,
      });
      return {
        ok: true,
        uploaded: 0,
        failed: 0,
        stoppedOffline: true,
        pending: pendingItems.length,
      };
    }
  }
  for (const item of q.items) {
    if (item.status === 'ok' || item.status === 'error') continue;
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      item.status = 'error';
      item.error = 'Photo file missing';
      item.updatedAt = new Date().toISOString();
      notifyUploadQueueItem(item);
      failed++;
      continue;
    }
    item.status = 'pending';
    item.updatedAt = new Date().toISOString();
    notifyUploadQueueItem(item);
    // Persist pending ASAP so a concurrent enqueue merge cannot lose this row.
    saveUploadQueue(q);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    let r;
      try {
        r = await uploadPhotoOnce(item, ac.signal);
      } catch (e) {
        r = { ok: false, error: String(e) };
      } finally {
        clearTimeout(timer);
      }

      item.attempts = (item.attempts || 0) + 1;
      item.updatedAt = new Date().toISOString();
      if (r.ok) {
        item.status = 'ok';
        item.photoId = r.photoId;
        item.shareUrl = r.shareUrl;
        item.url = r.url;
        item.slug = r.slug;
        item.error = undefined;
        uploaded++;
        appendAppLog('info', 'gallery', 'upload ok', {
          variant: item.variant,
          file: path.basename(item.filePath),
          photoId: r.photoId,
        });
        notifyUploadQueueItem(item);
      } else {
        const offline = isLikelyOfflineError(r.error);
        item.status = offline ? 'queued' : 'error';
        item.error = r.error || 'Upload failed';
        failed++;
        appendAppLog(offline ? 'warn' : 'error', 'gallery', 'upload failed', {
          variant: item.variant,
          file: path.basename(item.filePath),
          offline,
          error: item.error,
        });
        notifyUploadQueueItem(item);
        if (offline) {
          stoppedOffline = true;
          break;
        }
      }
    saveUploadQueue(q);
  }
  saveUploadQueue(q);
  const fresh = loadUploadQueue();
  return {
    ok: true,
    uploaded,
    failed,
    stoppedOffline,
    pending: fresh.items.filter((i) => i.status !== 'ok' && i.status !== 'error').length,
  };
}

async function flushUploadQueue() {
  if (uploadFlushRunning) {
    uploadFlushAgain = true;
    return { ok: true, busy: true };
  }
  uploadFlushRunning = true;
  let uploaded = 0;
  let failed = 0;
  let pending = 0;
  try {
    // Bound passes so a pathological enqueue loop cannot hang forever.
    for (let pass = 0; pass < 8; pass++) {
      uploadFlushAgain = false;
      const r = await flushUploadQueuePass();
      uploaded += r.uploaded || 0;
      failed += r.failed || 0;
      pending = r.pending || 0;
      if (r.stoppedOffline) break;
      if (!uploadFlushAgain) break;
    }
  } finally {
    uploadFlushRunning = false;
  }
  // Enqueue may have landed in the finally window — kick one more flush.
  if (uploadFlushAgain) {
    const again = await flushUploadQueue();
    return {
      ok: true,
      uploaded: uploaded + (again.uploaded || 0),
      failed: failed + (again.failed || 0),
      pending: again.pending ?? pending,
    };
  }
  return { ok: true, uploaded, failed, pending };
}

function enqueueGalleryUpload(payload) {
  const abs = path.resolve(String(payload?.filePath || ''));
  const variant = String(payload?.variant || 'original');
  const q = loadUploadQueue();
  // Prefer an existing row for this file+variant — including already-ok (avoid re-upload duplicates).
  let item = q.items.find((i) => i.filePath === abs && i.variant === variant);
  const now = new Date().toISOString();
  if (item?.status === 'ok' && item.shareUrl) {
    notifyUploadQueueItem(item);
    return item;
  }
  if (!item) {
    item = {
      id: require('crypto').randomBytes(8).toString('hex'),
      filePath: abs,
      variant,
      apiBaseUrl: galleryBaseUrl(payload?.apiBaseUrl),
      uploadToken: String(payload?.uploadToken || '').trim(),
      eventPrefix: String(payload?.eventPrefix || 'session').trim() || 'session',
      guestEmail: String(payload?.guestEmail || '').trim(),
      canId: String(payload?.canId || '').trim(),
      canLabel: String(payload?.canLabel || '').trim(),
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    q.items.push(item);
  } else {
    item.apiBaseUrl = galleryBaseUrl(payload?.apiBaseUrl) || item.apiBaseUrl;
    item.uploadToken = String(payload?.uploadToken || '').trim() || item.uploadToken;
    item.eventPrefix =
      String(payload?.eventPrefix || '').trim() || item.eventPrefix || 'session';
    if (payload?.guestEmail) item.guestEmail = String(payload.guestEmail).trim();
    if (payload?.canId) item.canId = String(payload.canId).trim();
    if (payload?.canLabel) item.canLabel = String(payload.canLabel).trim();
    if (item.status !== 'ok') {
      item.status = 'queued';
      item.error = undefined;
    }
    item.updatedAt = now;
  }
  saveUploadQueue(q);
  notifyUploadQueueItem(item);
  if (uploadFlushRunning) uploadFlushAgain = true;
  return item;
}

ipcMain.handle('gallery:uploadPhoto', async (_e, payload) => {
  try {
    const base = galleryBaseUrl(payload?.apiBaseUrl);
    const token = String(payload?.uploadToken || '').trim();
    const filePath = String(payload?.filePath || '');
    if (!base || !token) {
      return { ok: false, error: 'Gallery API URL and upload token are required.' };
    }
    if (!filePath) return { ok: false, error: 'Missing filePath' };
    const abs = path.resolve(filePath);
    const captureRoot = path.resolve(getCaptureDir());
    if (!isPathUnder(abs, captureRoot)) {
      return { ok: false, error: 'Photo path outside capture directory.' };
    }
    if (!fs.existsSync(abs)) return { ok: false, error: 'Photo file not found.' };

    const item = enqueueGalleryUpload(payload);
    // Already uploaded successfully — do not POST again.
    if (item.status === 'ok' && item.shareUrl) {
      return {
        ok: true,
        slug: item.slug,
        photoId: item.photoId,
        shareUrl: normalizeGalleryPublicUrl(item.shareUrl, base),
        url: item.url,
        variant: item.variant,
        deduped: true,
      };
    }
    // Enqueue and drain in the background so a downed gallery cannot stall capture.
    void flushUploadQueue().catch((e) =>
      appendAppLog('warn', 'gallery', 'background queue flush failed', String(e)),
    );
    return {
      ok: false,
      queued: true,
      status: item.status || 'queued',
      error: item.error || 'Queued for upload when online',
    };
  } catch (e) {
    return { ok: false, queued: true, error: String(e) };
  }
});

ipcMain.handle('gallery:flushUploadQueue', async () => {
  try {
    return await flushUploadQueue();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('gallery:getUploadQueueSummary', async () => {
  try {
    return { ok: true, summary: summarizeUploadQueue() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('gallery:resyncUploadQueue', async (_e, payload) => {
  try {
    return await resyncUploadQueue(payload || {});
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('gallery:getUploadQueueItem', async (_e, filePath) => {
  try {
    const abs = path.resolve(String(filePath || ''));
    const items = loadUploadQueue().items.filter((i) => i.filePath === abs);
    let item =
      items.find((i) => i.status === 'ok') ||
      items.find((i) => i.status === 'pending' || i.status === 'queued') ||
      items[items.length - 1] ||
      null;
    if (item?.shareUrl && item?.apiBaseUrl) {
      item = {
        ...item,
        shareUrl: normalizeGalleryPublicUrl(item.shareUrl, item.apiBaseUrl),
      };
    }
    return { ok: true, item };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

async function fetchRemoteFrames(base, signal) {
  const res = await fetch(`${base}/api/frames`, { signal });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return Array.isArray(data.frames) ? data.frames : [];
}

async function publishLocalFrameFile(base, token, filename, signal) {
  const safe = path.basename(String(filename || ''));
  if (!safe || safe.includes('..')) return { ok: false, error: 'Invalid filename' };
  const full = path.join(getPhotoFramesDir(), safe);
  if (!isPathUnderOrEqual(full, getPhotoFramesDir()) || !fs.existsSync(full)) {
    return { ok: false, error: 'Frame not found locally.' };
  }
  const FormData = require('form-data');
  const buf = fs.readFileSync(full);
  const ext = path.extname(full).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const form = new FormData();
  form.append('frame', buf, {
    filename: safe,
    contentType: mime,
    knownLength: buf.length,
  });
  form.append('filename', safe);
  const bodyBuf = form.getBuffer();
  const res = await fetch(`${base}/api/frames`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
      'Content-Length': String(bodyBuf.length),
    },
    body: bodyBuf,
    signal,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok || !data?.ok) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  return { ok: true, frame: data.frame };
}

async function deleteRemoteFrameFile(base, token, filename) {
  const safe = path.basename(String(filename || ''));
  if (!safe || safe.includes('..')) return { ok: false, error: 'Invalid filename' };
  const res = await fetch(`${base}/api/frames/${encodeURIComponent(safe)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok || !data?.ok) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  return { ok: true, removed: data.removed || safe };
}

async function pullRemoteFramesToLocal(base, remoteFrames, signal) {
  const dir = getPhotoFramesDir();
  const synced = [];
  const skipped = [];
  const failed = [];
  for (const frame of remoteFrames || []) {
    const filename = path.basename(String(frame.filename || ''));
    if (!filename || filename.includes('..')) continue;
    const dest = path.join(dir, filename);
    const remoteBytes = Number(frame.bytes);
    if (Number.isFinite(remoteBytes) && remoteBytes > 0 && fs.existsSync(dest)) {
      try {
        if (fs.statSync(dest).size === remoteBytes) {
          skipped.push(filename);
          continue;
        }
      } catch (_) {}
    }
    const url = `${base}${frame.url || `/media/frames/${encodeURIComponent(filename)}`}`;
    try {
      const imgRes = await fetch(url, { signal });
      if (!imgRes.ok) {
        failed.push({ filename, error: `HTTP ${imgRes.status}` });
        continue;
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      fs.writeFileSync(dest, buf);
      synced.push(filename);
    } catch (e) {
      failed.push({ filename, error: String(e) });
    }
  }
  return { synced, skipped, failed };
}

/**
 * Two-way frame sync with Moments:
 * 1) Push local frames (when token provided) so booth overlays appear on the gallery host
 * 2) Pull remote frames so Moments admin uploads show on the booth
 * 3) Optionally prune local files missing from the remote set (Moments deletes)
 * Offline / timeout: returns { ok:false, offline:true } so callers keep local frames.
 * Never throws to the caller — booth UI must stay usable without a network.
 */
let framesSyncChain = Promise.resolve();

async function syncFramesWithMoments(payload) {
  const run = framesSyncChain.then(
    () => syncFramesWithMomentsOnce(payload),
    () => syncFramesWithMomentsOnce(payload),
  );
  framesSyncChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function syncFramesWithMomentsOnce(payload) {
  const base = galleryBaseUrl(payload?.apiBaseUrl);
  if (!base) return { ok: false, error: 'Gallery API URL is required.' };
  const token = String(payload?.uploadToken || '').trim();
  const pushLocal = payload?.pushLocal === true;
  const pruneLocal = payload?.pruneLocal === true;
  const timeoutMs =
    Number.isFinite(Number(payload?.timeoutMs)) && Number(payload.timeoutMs) > 0
      ? Number(payload.timeoutMs)
      : 12000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const remote = await fetchRemoteFrames(base, ac.signal);
    const remoteNames = new Set(
      remote.map((f) => path.basename(String(f.filename || ''))).filter(Boolean),
    );

    const { synced, skipped, failed } = await pullRemoteFramesToLocal(base, remote, ac.signal);

    const pruned = [];
    const pullFailed = failed.length > 0;
    if (pruneLocal && !pullFailed) {
      const dir = getPhotoFramesDir();
      for (const filename of listPhotoFrameFiles()) {
        if (remoteNames.has(filename)) continue;
        try {
          fs.unlinkSync(path.join(dir, filename));
          pruned.push(filename);
        } catch (_) {}
      }
    }

    // Push only leftover local-only files (after prune, this is typically empty).
    const published = [];
    const publishFailed = [];
    if (token && pushLocal) {
      for (const filename of listPhotoFrameFiles()) {
        if (ac.signal.aborted) break;
        if (remoteNames.has(filename)) continue;
        const r = await publishLocalFrameFile(base, token, filename, ac.signal);
        if (r.ok) published.push(filename);
        else publishFailed.push({ filename, error: r.error || 'Publish failed' });
      }
    }

    return {
      ok: true,
      synced,
      skipped,
      published,
      pruned,
      failed: [...publishFailed, ...failed],
      count: synced.length,
      skippedCount: skipped.length,
      publishedCount: published.length,
      prunedCount: pruned.length,
    };
  } catch (e) {
    const msg = String(e?.message || e);
    const offline =
      e?.name === 'AbortError' ||
      /abort|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|offline/i.test(msg);
    return {
      ok: false,
      offline,
      error: offline ? 'Moments unreachable — using local frames' : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

function gallerySettingsFromConfig() {
  const g = loadMergedConfig().gallery || {};
  return {
    apiBaseUrl: galleryBaseUrl(g.apiBaseUrl),
  };
}

async function syncFramesOnStartup() {
  const g = gallerySettingsFromConfig();
  if (!g.apiBaseUrl) return;
  if (!(await galleryReachable(g.apiBaseUrl, 2500))) {
    appendAppLog('info', 'frames', 'startup sync skipped — Moments unreachable (keeping local frames)');
    return;
  }
  const r = await syncFramesWithMoments({
    apiBaseUrl: g.apiBaseUrl,
    uploadToken: undefined,
    pushLocal: false,
    pruneLocal: true,
    timeoutMs: 20000,
  });
  if (r.ok) {
    appendAppLog('info', 'frames', 'startup sync ok', {
      pulled: r.count || 0,
      skipped: r.skippedCount || 0,
      pruned: r.prunedCount || (r.pruned || []).length,
    });
  } else {
    appendAppLog(r.offline ? 'warn' : 'error', 'frames', 'startup sync failed', {
      offline: !!r.offline,
      error: r.error,
    });
  }
}

ipcMain.handle('gallery:ping', async () => {
  try {
    const g = loadMergedConfig().gallery || {};
    if (g.enabled === false) {
      return { ok: true, enabled: false, reachable: true, skipped: true };
    }
    const base = galleryBaseUrl(g.apiBaseUrl);
    if (!base) {
      return { ok: true, enabled: true, reachable: false, error: 'Gallery API URL is not configured.' };
    }
    const reachable = await galleryReachable(base, 2500);
    return { ok: true, enabled: true, reachable, apiBaseUrl: base };
  } catch (e) {
    return { ok: false, enabled: true, reachable: false, error: String(e) };
  }
});

ipcMain.handle('gallery:syncFrames', async (_e, payload) => {
  try {
    return await syncFramesWithMoments(payload || {});
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('gallery:publishFrame', async (_e, payload) => {
  try {
    const base = galleryBaseUrl(payload?.apiBaseUrl);
    const token = String(payload?.uploadToken || '').trim();
    const filename = path.basename(String(payload?.filename || ''));
    if (!base || !token) {
      return { ok: false, error: 'Gallery API URL and upload token are required.' };
    }
    if (!filename) return { ok: false, error: 'Missing filename' };
    return await publishLocalFrameFile(base, token, filename);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('gallery:deleteRemoteFrame', async (_e, payload) => {
  try {
    const base = galleryBaseUrl(payload?.apiBaseUrl);
    const token = String(payload?.uploadToken || '').trim();
    const filename = path.basename(String(payload?.filename || ''));
    if (!base || !token) {
      return { ok: false, error: 'Gallery API URL and upload token are required.' };
    }
    if (!filename) return { ok: false, error: 'Missing filename' };
    return await deleteRemoteFrameFile(base, token, filename);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/** Classify Windows printer driver/port for booth use (DNP RX1 / Canon SELPHY). */
function classifyPrinter(driverName, portName, printerName) {
  const d = String(driverName || '').trim();
  const p = String(portName || '').trim();
  const n = String(printerName || '').trim();
  const blob = `${n} ${d} ${p}`;
  const isVirtual =
    /pdf|xps|onenote|fax|microsoft\s+print\s+to|send\s+to|document\s+writer|redirect/i.test(blob) ||
    /^FILE:|^PORTPROMPT:|^nul:|^SHRFAX:/i.test(p);
  const isNetworkPort =
    /^\\\\/.test(p) ||
    /^(IP_|WSD-|WSD_|IPP|HTTP|HTTPS|TCP)/i.test(p) ||
    /^(WSD|IPP)/i.test(p) ||
    /https?:/i.test(p);
  const usesIppDriver = /microsoft\s+ipp|ipp\s+class\s+driver/i.test(d);
  const isIppClass =
    usesIppDriver ||
    (/class\s+driver/i.test(d) && /microsoft|ipp|wsd/i.test(d) && !/canon|selphy|dnp|ds-?rx1/i.test(d)) ||
    (/\bwsd\b/i.test(d) && !/canon|selphy|dnp|ds-?rx1/i.test(d)) ||
    isNetworkPort;
  const isCanonDriver = /canon|selphy/i.test(d) && !usesIppDriver;
  const isCanonName = /canon|selphy/i.test(n);
  const isDnpDriver = /dnp|dai\s*nippon|ds-?rx1/i.test(d);
  const isDnpName = /dnp|ds-?rx1|\brx1\b/i.test(n);
  const isBoothPhotoPrinter = isCanonDriver || isCanonName || isDnpDriver || isDnpName;
  const isUsbPort =
    !!p &&
    !isNetworkPort &&
    (/^USB\d*$/i.test(p) ||
      /^DOT4_/i.test(p) ||
      (/USB/i.test(p) && !/^\\\\/.test(p)));
  const isUsb =
    !isVirtual && (isUsbPort || (!isIppClass && !isNetworkPort && isBoothPhotoPrinter));
  const isNetwork = !isVirtual && !isUsb && (isNetworkPort || (isIppClass && !isUsbPort));
  return {
    isIppClass: isIppClass && !isUsbPort,
    usesIppDriver,
    isCanonDriver: isCanonDriver || isCanonName,
    isDnpDriver: isDnpDriver || isDnpName,
    isUsb,
    isNetwork,
    isVirtual,
  };
}

function printAllowWifi(override) {
  if (typeof override === 'boolean') return override;
  try {
    return loadMergedConfig()?.print?.allowWifiPrinters === true;
  } catch (_) {
    return false;
  }
}

function mapWinPrinter(w) {
  const name = String(w.Name || '');
  const driverName = String(w.DriverName || '');
  const portName = String(w.PortName || '');
  const flags = classifyPrinter(driverName, portName, name);
  return {
    name,
    displayName: name,
    description: driverName,
    isDefault: !!w.Default,
    status: 0,
    driverName,
    portName,
    ...flags,
  };
}

/** Prefer USB DNP RX1 / Canon; USB IPP next; Wi‑Fi last if enabled. */
function pickBestBoothPrinter(printers, allowWifi) {
  const pool = boothPrintQueues(printers, allowWifi);
  if (!pool.length) return null;
  const usb = pool.filter((p) => p.isUsb);
  const wifi = pool.filter((p) => !p.isUsb);
  const usbDnp =
    usb.find((p) => p.isDnpDriver && !p.usesIppDriver) ||
    usb.find((p) => /dnp|ds-?rx1|\brx1\b/i.test(p.name) && !p.usesIppDriver);
  if (usbDnp) return usbDnp;
  const usbCanon =
    usb.find((p) => p.isCanonDriver && !p.usesIppDriver) ||
    usb.find((p) => /canon|selphy/i.test(p.name) && !p.usesIppDriver);
  if (usbCanon) return usbCanon;
  const usbIpp = usb.find(
    (p) => p.usesIppDriver && (/dnp|ds-?rx1|canon|selphy/i.test(p.name) || p.isDnpDriver || p.isCanonDriver),
  );
  if (usbIpp) return usbIpp;
  if (usb.length) return usb.find((p) => p.isDefault) || usb[0];
  if (!allowWifi) return null;
  const wifiBooth =
    wifi.find((p) => p.isDnpDriver) ||
    wifi.find((p) => p.isCanonDriver) ||
    wifi.find((p) => /dnp|ds-?rx1|canon|selphy/i.test(p.name));
  return wifiBooth || wifi.find((p) => p.isDefault) || wifi[0] || null;
}

function isDnpPrinterName(name) {
  return /dnp|ds-?rx1|\brx1\b/i.test(String(name || ''));
}

function formatPrintTimestamp(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toLocaleString();
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Burn local capture time onto a corner of the print raster. */
async function stampPrintTimestamp(imagePath, timestampIso) {
  const sharp = require('sharp');
  const abs = path.resolve(imagePath);
  const meta = await sharp(abs).metadata();
  const w = meta.width || 1200;
  const h = meta.height || 1800;
  const label = formatPrintTimestamp(timestampIso);
  const fontSize = Math.max(22, Math.round(Math.min(w, h) * 0.028));
  const pad = Math.round(fontSize * 0.55);
  const boxH = Math.round(fontSize * 1.7);
  const approxW = Math.round(label.length * fontSize * 0.62 + pad * 2);
  const svg = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${w - approxW - pad}" y="${h - boxH - pad}" width="${approxW}" height="${boxH}"
        rx="6" ry="6" fill="rgba(0,0,0,0.55)"/>
  <text x="${w - pad * 1.4}" y="${h - pad - Math.round(fontSize * 0.45)}"
        text-anchor="end" font-family="Segoe UI, Arial, sans-serif"
        font-size="${fontSize}" font-weight="600" fill="#ffffff">${label
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')}</text>
</svg>`,
  );
  const out = path.join(os.tmpdir(), `pb-stamp-${Date.now()}.jpg`);
  await sharp(abs)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 95, mozjpeg: true })
    .toFile(out);
  return out;
}

async function listWindowsPrintersDetailed() {
  let winDetails = [];
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PortName,Default | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
    winDetails = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (e) {
    appendAppLog('warn', 'print', 'Win32_Printer enrich failed', String(e));
  }

  // Win32 is source of truth for PortName (Electron often omits it → false "no USB").
  /** @type {ReturnType<typeof mapWinPrinter>[]} */
  const printers = winDetails.map(mapWinPrinter);
  const byName = new Map(printers.map((p) => [p.name.toLowerCase(), p]));

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const electronPrinters = await mainWindow.webContents.getPrintersAsync();
      for (const ep of electronPrinters || []) {
        const key = String(ep.name || '').toLowerCase();
        const existing = byName.get(key);
        if (existing) {
          if (ep.isDefault) existing.isDefault = true;
          if (ep.displayName) existing.displayName = ep.displayName;
          if (typeof ep.status === 'number') existing.status = ep.status;
          continue;
        }
        // Electron-only entry with no Win32 row — classify without port (Canon name still helps).
        const flags = classifyPrinter('', '', ep.name);
        const row = {
          name: ep.name,
          displayName: ep.displayName || ep.name,
          description: ep.description || '',
          isDefault: !!ep.isDefault,
          status: ep.status,
          driverName: '',
          portName: '',
          ...flags,
        };
        printers.push(row);
        byName.set(key, row);
      }
    } catch (e) {
      appendAppLog('warn', 'print', 'getPrintersAsync failed', String(e));
    }
  }

  return printers;
}

function boothPrintQueues(all, allowWifi = false) {
  return (all || []).filter((p) => {
    if (!p || p.isVirtual) return false;
    if (p.isUsb) return true;
    return !!allowWifi && (p.isNetwork || p.isIppClass);
  });
}

function preferredPrinterIsAllowed(meta, allowWifi) {
  if (!meta || meta.isVirtual) return false;
  if (meta.isUsb) return true;
  return !!allowWifi && (meta.isNetwork || meta.isIppClass);
}

ipcMain.handle('print:listPrinters', async (_e, payload) => {
  try {
    const allowWifi = printAllowWifi(payload?.allowWifi);
    const probe = await probeSelphyUsb();
    const all = await listWindowsPrintersDetailed();
    const printers = boothPrintQueues(all, allowWifi);
    return {
      ok: true,
      printers,
      usbCount: printers.filter((p) => p.isUsb).length,
      totalCount: all.length,
      allowWifi,
      selphyUsb: probe,
      skipped: all
        .filter((p) => !printers.some((u) => u.name === p.name))
        .map((p) => ({ name: p.name, portName: p.portName, driverName: p.driverName })),
    };
  } catch (e) {
    appendAppLog('error', 'print', 'listPrinters failed', String(e));
    return { ok: false, printers: [], error: String(e) };
  }
});

ipcMain.handle('print:repairSelphyUsb', async () => {
  try {
    const allowWifi = printAllowWifi();
    const repair = await repairSelphyUsb({ elevateIfNeeded: true, force: true });
    const all = await listWindowsPrintersDetailed();
    const printers = boothPrintQueues(all, allowWifi);
    return { ok: !!repair?.ok || printers.length > 0, repair, printers, selphyUsb: repair?.probe };
  } catch (e) {
    appendAppLog('error', 'print', 'repairSelphyUsb failed', String(e));
    return { ok: false, error: String(e) };
  }
});

/**
 * Windows photo print for kiosk — DNP DS-RX1 4×6″ or Canon SELPHY postcard 100×148 mm.
 */
async function printPhotoViaWindowsSpooler(imagePath, printerName, bleedScale = 1.06, options = {}) {
  const abs = path.resolve(imagePath);
  if (!fs.existsSync(abs)) {
    throw new Error('Photo file not found.');
  }
  const physicalPostcard = options.physicalPostcard === true;
  const bleed = physicalPostcard
    ? 1
    : Math.min(1.12, Math.max(1.0, Number(bleedScale) || 1.06));
  const fitMode = physicalPostcard
    ? 'postcard'
    : options.fitMode === 'contain'
      ? 'contain'
      : 'cover';
  const media = options.media === 'dnp-4x6' || isDnpPrinterName(printerName) ? 'dnp-4x6' : 'selphy';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-spool-'));
  const ps1 = path.join(tmpDir, 'photoprint.ps1');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$imgPath = ${psQuote(abs)}
$printerName = ${printerName ? psQuote(printerName) : "''"}
$bleed = ${bleed}
$fitMode = ${psQuote(fitMode)}
$media = ${psQuote(media)}
$img = [System.Drawing.Image]::FromFile($imgPath)
try {
  $doc = New-Object System.Drawing.Printing.PrintDocument
  if ($media -eq 'dnp-4x6') { $doc.DocumentName = 'PhotoBooth DS-RX1' } else { $doc.DocumentName = 'PhotoBooth SELPHY' }
  $doc.OriginAtMargins = $false
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController

  if ($printerName -and $printerName.Trim().Length -gt 0) {
    $doc.PrinterSettings.PrinterName = $printerName
  }
  if (-not $doc.PrinterSettings.IsValid) {
    throw "Printer is not valid or not installed: $printerName"
  }

  $doc.PrinterSettings.Copies = 1
  $doc.DefaultPageSettings.Color = $true
  try { $doc.PrinterSettings.DefaultPageSettings.Color = $true } catch {}
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

  if ($media -eq 'dnp-4x6') {
    # DNP DS-RX1 standard 4x6 inch (101.6 x 152.4 mm)
    $targetW = [int][Math]::Round(6.0 * 100)
    $targetH = [int][Math]::Round(4.0 * 100)
    $paperMatch = '(?i)4\\s*[x×]\\s*6|6\\s*[x×]\\s*4|10\\s*[x×]\\s*15|RX1|PC|L size'
  } else {
    # Canon SELPHY CP1500 postcard is 100.0 x 148.0 mm (not 6x4 inch).
    $targetW = [int][Math]::Round(148.0 / 25.4 * 100)
    $targetH = [int][Math]::Round(100.0 / 25.4 * 100)
    $paperMatch = '(?i)postcard|hagaki|kp-?108|100\\s*[x×]\\s*148|148\\s*[x×]\\s*100'
  }

  $chosenPaper = $null
  foreach ($ps in $doc.PrinterSettings.PaperSizes) {
    $n = [string]$ps.PaperName
    if ($n -match $paperMatch) {
      $chosenPaper = $ps
      break
    }
  }
  if ($chosenPaper -eq $null) {
    $best = $null
    $bestDelta = 99999
    foreach ($ps in $doc.PrinterSettings.PaperSizes) {
      $a = [Math]::Min($ps.Width, $ps.Height)
      $b = [Math]::Max($ps.Width, $ps.Height)
      $delta = [Math]::Abs($a - $targetH) + [Math]::Abs($b - $targetW)
      if ($media -eq 'dnp-4x6') {
        $inRange = ($a -ge 370 -and $a -le 450 -and $b -ge 550 -and $b -le 650)
      } else {
        $inRange = ($a -ge 370 -and $a -le 430 -and $b -ge 540 -and $b -le 630)
      }
      if ($delta -lt $bestDelta -and $inRange) {
        $best = $ps
        $bestDelta = $delta
      }
    }
    $chosenPaper = $best
  }
  if ($chosenPaper -eq $null) {
    if ($media -eq 'dnp-4x6') { $label = 'DNP 4x6' } else { $label = 'SELPHY Postcard 100x148mm' }
    $chosenPaper = New-Object System.Drawing.Printing.PaperSize($label, $targetW, $targetH)
    try { $doc.PrinterSettings.PaperSizes.Add($chosenPaper) } catch {}
  }
  $doc.DefaultPageSettings.PaperSize = $chosenPaper
  if ($chosenPaper.Width -ge $chosenPaper.Height) {
    $doc.DefaultPageSettings.Landscape = $false
  } else {
    $doc.DefaultPageSettings.Landscape = $true
  }

  $script:pbImg = $img
  $script:paperName = $chosenPaper.PaperName
  $script:bleed = $bleed
  $script:fitMode = $fitMode
  $script:targetW = $targetW
  $script:targetH = $targetH
  $doc.add_PrintPage({
    param($sender, $e)
    $page = $e.PageBounds
    $iw = [double]$script:pbImg.Width
    $ih = [double]$script:pbImg.Height
    if ($iw -le 0 -or $ih -le 0) { throw 'Image has zero size' }
    if ($script:fitMode -eq 'postcard') {
      $tw = [double]$script:targetW
      $th = [double]$script:targetH
      $fit = [Math]::Min(($page.Width / $tw), ($page.Height / $th))
      if ($fit -gt 1) { $fit = 1 }
      $w = [int][Math]::Round($tw * $fit)
      $h = [int][Math]::Round($th * $fit)
    } elseif ($script:fitMode -eq 'contain') {
      $scale = [Math]::Min(($page.Width / $iw), ($page.Height / $ih)) * [double]$script:bleed
      $w = [int]([Math]::Ceiling($iw * $scale))
      $h = [int]([Math]::Ceiling($ih * $scale))
    } else {
      $scale = [Math]::Max(($page.Width / $iw), ($page.Height / $ih)) * [double]$script:bleed
      $w = [int]([Math]::Ceiling($iw * $scale))
      $h = [int]([Math]::Ceiling($ih * $scale))
    }
    $x = $page.X + [int]([Math]::Floor(($page.Width - $w) / 2.0))
    $y = $page.Y + [int]([Math]::Floor(($page.Height - $h) / 2.0))
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $e.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $e.Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $e.Graphics.DrawImage($script:pbImg, $x, $y, $w, $h)
    $e.HasMorePages = $false
  })

  $doc.Print()
  Write-Output ("OK|" + $doc.PrinterSettings.PrinterName + "|" + $script:paperName + "|" + $script:bleed)
} finally {
  if ($img) { $img.Dispose() }
}
`;
  fs.writeFileSync(ps1, script, 'utf8');
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        ps1,
      ],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    const line = String(stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.startsWith('OK|'));
    if (!line) {
      const errTail = String(stderr || stdout || '').trim().slice(0, 300);
      throw new Error(errTail || 'Print spooler returned no confirmation.');
    }
    const parts = line.split('|');
    return {
      printer: parts[1] || printerName || null,
      paper: parts[2] || null,
      bleed: parts[3] || String(bleed),
    };
  } catch (e) {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join(' | ');
    throw new Error(String(detail || e).replace(/\s+/g, ' ').trim().slice(0, 500));
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * One-shot photo print of the original capture file (DSLR → SELPHY postcard).
 */
async function resolveBoothPrinter(preferredName) {
  const allowWifi = printAllowWifi();
  const all = await listWindowsPrintersDetailed();
  const usbList = boothPrintQueues(all, allowWifi);
  if (!usbList.length) {
    const probe = await probeSelphyUsb();
    const seen = all
      .slice(0, 8)
      .map((p) => `${p.name} [${p.portName || 'no-port'}]`)
      .join('; ');
    const code28 = probe?.code28 ? ' Device Manager Code 28: USB print driver did not bind.' : '';
    const wifiHint = allowWifi
      ? ' Enable a USB or Wi‑Fi queue in Printers & scanners.'
      : ' Plug DS-RX1 / SELPHY in by USB, or enable Show Wi‑Fi printers.';
    return {
      ok: false,
      error: seen
        ? `No usable printer queue found. Windows sees: ${seen}.${code28}${wifiHint}`
        : `No printer found.${code28}${wifiHint}`,
      all,
      usbList,
    };
  }

  const preferred =
    typeof preferredName === 'string' && preferredName.trim() ? preferredName.trim() : null;
  let chosen = preferred;
  const preferredMeta = preferred ? all.find((p) => p.name === preferred) : null;
  if (preferred) {
    if (!preferredMeta) {
      const seen = all
        .filter((p) => !p.isVirtual)
        .slice(0, 10)
        .map((p) => p.name)
        .join(', ');
      return {
        ok: false,
        error: `Configured printer "${preferred}" is not installed as a Windows print queue yet. Device Manager can show DS-RX1 before the DNP driver creates the queue. Install the RX1 driver, then confirm the queue name matches exactly. Windows currently has: ${seen || 'none'}.`,
        all,
        usbList,
      };
    }
    if (!preferredPrinterIsAllowed(preferredMeta, allowWifi)) {
      return {
        ok: false,
        error: `Printer "${preferred}" is installed but not usable (port ${preferredMeta.portName || 'unknown'}, driver ${preferredMeta.driverName || 'unknown'}). Use USB and the DNP DS-RX1 driver.`,
        all,
        usbList,
      };
    }
    chosen = preferredMeta.name;
  } else {
    const auto = pickBestBoothPrinter(usbList, allowWifi);
    if (!auto) {
      return { ok: false, error: 'No usable printer queue found.', all, usbList };
    }
    chosen = auto.name;
  }
  return { ok: true, chosen, all, usbList };
}

async function printPhotoInternal(payload) {
  try {
    const filePath = String(payload?.filePath || '').trim();
    const deviceName =
      typeof payload?.deviceName === 'string' && payload.deviceName.trim()
        ? payload.deviceName.trim()
        : null;
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: 'Photo file not found.' };
    }
    const cfg = loadMergedConfig();
    const printCfg = cfg.print || {};
    if (!(printCfg.enabled === true || printCfg.enabled === 'true' || printCfg.enabled === 1)) {
      return { ok: false, error: 'Printing is disabled in Admin → Print.' };
    }
    const bleedScale =
      typeof printCfg.bleedScale === 'number' && Number.isFinite(printCfg.bleedScale)
        ? printCfg.bleedScale
        : 1.06;

    const abs = path.resolve(filePath);
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Photo printing is only supported on Windows.' };
    }

    const preferred =
      deviceName ||
      (typeof printCfg.printerName === 'string' && printCfg.printerName.trim()
        ? printCfg.printerName.trim()
        : null);
    const resolved = await resolveBoothPrinter(preferred);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const physicalLayout =
      payload?.layoutMode === 'physicalFrame' || isPhysicalFrameLayoutPath(abs);
    const framedLayout = !physicalLayout && isFramedPrintPath(abs);
    let printPath = abs;
    let printTmp = null;
    let stampTmp = null;
    if (physicalLayout || framedLayout) {
      let sharpMod;
      try {
        sharpMod = require('sharp');
      } catch (_dep) {
        return { ok: false, error: 'Frame print requires sharp.' };
      }
      const dpi = Math.round(Number(loadMergedConfig()?.physicalFrame?.dpi) || 300);
      if (physicalLayout) {
        printTmp = await preparePhysicalFramePrintRaster(
          sharpMod,
          abs,
          dpi,
          Number(loadMergedConfig()?.physicalFrame?.printerCropInsetMm ?? 4),
        );
      } else {
        printTmp = await prepareFramedPrintRaster(
          sharpMod,
          abs,
          dpi,
          Number(printCfg.framedEdgeInsetMm ?? 4),
          Number(printCfg.framedBottomExtraMm ?? 2.5),
        );
      }
      printPath = printTmp;
      appendAppLog('info', 'print', 'layout flattened for single spool', {
        source: abs,
        raster: printPath,
        physicalLayout,
        framedLayout,
      });
    }

    const stampOn = printCfg.stampTime !== false;
    const stampIso = payload?.timestamp || payload?.createdAt || null;
    if (stampOn && !physicalLayout) {
      try {
        stampTmp = await stampPrintTimestamp(printPath, stampIso);
        printPath = stampTmp;
      } catch (stampErr) {
        appendAppLog('warn', 'print', 'timestamp stamp skipped', String(stampErr));
      }
    }

    try {
      const keepEdges = physicalLayout || framedLayout;
      const media = isDnpPrinterName(resolved.chosen) ? 'dnp-4x6' : 'selphy';
      const result = await printPhotoViaWindowsSpooler(
        printPath,
        resolved.chosen,
        keepEdges ? 1 : bleedScale,
        {
          fitMode: keepEdges ? 'contain' : 'cover',
          physicalPostcard: keepEdges && media === 'selphy',
          media,
        },
      );
      appendAppLog('info', 'print', 'photoprint spooled', {
        filePath: abs,
        printPath,
        physicalLayout,
        framedLayout,
        media,
        stamped: !!stampTmp,
        bytes: fs.statSync(printPath).size,
        deviceName: result.printer || resolved.chosen || 'default',
        paper: result.paper || null,
        bleed: result.bleed || (keepEdges ? 1 : bleedScale),
      });
      return {
        ok: true,
        deviceName: result.printer || resolved.chosen || null,
        paper: result.paper || null,
      };
    } finally {
      for (const tmp of [printTmp, stampTmp]) {
        if (!tmp) continue;
        try {
          fs.unlinkSync(tmp);
        } catch (_) {}
      }
    }
  } catch (e) {
    const msg = String(e?.message || e);
    appendAppLog('error', 'print', 'print:photo failed', msg);
    return { ok: false, error: msg.replace(/\s+/g, ' ').trim().slice(0, 400) };
  }
}

ipcMain.handle('print:photo', async (_e, payload) => printPhotoInternal(payload));

/** Admin test print — solid 6×4 JPEG to verify SELPHY USB path. */
ipcMain.handle('print:test', async () => {
  let tmp = null;
  try {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Photo printing is only supported on Windows.' };
    }
    const cfg = loadMergedConfig();
    const printCfg = cfg.print || {};
    const preferred =
      typeof printCfg.printerName === 'string' && printCfg.printerName.trim()
        ? printCfg.printerName.trim()
        : null;
    const resolved = await resolveBoothPrinter(preferred);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const sharp = require('sharp');
    tmp = path.join(os.tmpdir(), `pb-print-test-${Date.now()}.jpg`);
    // 1800×1200 ≈ 6×4 @ 300dpi
    await sharp({
      create: {
        width: 1800,
        height: 1200,
        channels: 3,
        background: { r: 34, g: 90, b: 56 },
      },
    })
      .jpeg({ quality: 92 })
      .toFile(tmp);

    const bleedScale =
      typeof printCfg.bleedScale === 'number' && Number.isFinite(printCfg.bleedScale)
        ? printCfg.bleedScale
        : 1.06;
    const result = await printPhotoViaWindowsSpooler(tmp, resolved.chosen, bleedScale);
    appendAppLog('info', 'print', 'test print spooled', {
      deviceName: result.printer || resolved.chosen,
      paper: result.paper || null,
    });
    return {
      ok: true,
      deviceName: result.printer || resolved.chosen || null,
      paper: result.paper || null,
    };
  } catch (e) {
    const msg = String(e?.message || e);
    appendAppLog('error', 'print', 'print:test failed', msg);
    return { ok: false, error: msg.replace(/\s+/g, ' ').trim().slice(0, 400) };
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (_) {}
    }
  }
});

function requirePipeline() {
  if (!jobPipeline) {
    jobPipeline = createJobPipeline({
      getStorePath: () => path.join(getPortableRoot(), 'data', 'jobs.json'),
      getConfig: () => loadMergedConfig(),
      generateAi: (payload) => generateAiImage(payload),
      printPhoto: (payload) => printPhotoInternal(payload),
      uploadJob: uploadJobToCloud,
      reportStatus: pushBoothJobStatus,
      log: (level, scope, message, detail) => appendAppLog(level, scope, message, detail),
      onJobsUpdated: (summary) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('jobs:updated', summary);
        }
      },
    });
  }
  return jobPipeline;
}

ipcMain.handle('jobs:enqueue', async (_e, payload) => {
  try {
    const job = requirePipeline().enqueueCapture(payload || {});
    return { ok: true, job };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('jobs:list', async () => {
  try {
    const jobs = requirePipeline().listJobs();
    return { ok: true, jobs, summary: requirePipeline().summarize() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('jobs:get', async (_e, id) => {
  try {
    const job = requirePipeline().getJob(id);
    if (!job) return { ok: false, error: 'Job not found' };
    return { ok: true, job };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('jobs:printOp', async (_e, payload) => {
  try {
    const id = String(payload?.id || '');
    const op = String(payload?.op || '');
    return requirePipeline().printOp(id, op);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('jobs:setDisplayPicked', async (_e, payload) => {
  try {
    return requirePipeline().setDisplayPicked(payload?.id, payload?.picked);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('jobs:kick', async () => {
  try {
    requirePipeline().kick();
    return { ok: true, summary: requirePipeline().summarize() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
