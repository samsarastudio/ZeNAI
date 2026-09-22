/**
 * After electron-builder: stage a deploy folder that matches win-unpacked
 * (edsdk-bridge + Canon DLLs + config + themes), stamp version.json, zip for
 * Moments OTA upload, and pair the portable exe with native sidecars.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const appRoot = path.join(__dirname, '..');
const releaseDir = path.join(appRoot, 'release');
const binDir = path.join(appRoot, 'bin');
const buildsRoot = path.join(appRoot, '..', 'builds');
const unpacked = path.join(releaseDir, 'win-unpacked');
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');
const portableExe = path.join(releaseDir, `ZYN-Photobooth-Portable-${version}.exe`);

const NATIVE = ['edsdk-bridge.exe', 'EDSDK.dll', 'EdsImage.dll'];
const EXE_NAME = 'ZYN-Photobooth.exe';

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

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function assertNativeIn(dir, label) {
  const missing = NATIVE.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) {
    throw new Error(`${label} missing native camera files: ${missing.join(', ')}`);
  }
  console.log(`[package-deploy] ${label}: OK (${NATIVE.join(', ')})`);
}

function writeVersionFile(dir, buildId, channel) {
  const payload = {
    version,
    buildId,
    builtAt: new Date().toISOString(),
    channel,
    productName: 'ZYN Photobooth',
  };
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function assertZipHasPhotoBooth(zipPath) {
  const listing = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${psQuote(zipPath)}); try { $z.Entries | Where-Object { $_.FullName -match 'ZYN-Photobooth\\.exe$' } | Select-Object -ExpandProperty FullName } finally { $z.Dispose() }`,
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  if (!/ZYN-Photobooth\.exe/i.test(listing)) {
    throw new Error('Zip is missing ZYN-Photobooth.exe — aborting.');
  }
  const count = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${psQuote(zipPath)}); try { $z.Entries.Count } finally { $z.Dispose() }`,
    ],
    { windowsHide: true, encoding: 'utf8' },
  ).trim();
  console.log(
    `[package-deploy] zip OK (${Math.round(fs.statSync(zipPath).size / (1024 * 1024))} MB, ${count} entries) includes:\n${listing.trim()}`,
  );
}

function zipFolder(folderPath, zipPath) {
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  // Copy to temp first so locks from a running PhotoBooth.exe don't break zipping.
  // Avoid Windows `tar -a` — those zips often show as empty in Explorer.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ota-zip-'));
  const staged = path.join(tmpRoot, 'payload');
  try {
    console.log(`[package-deploy] Staging zip copy → ${staged}`);
    copyDir(folderPath, staged);
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$items = @(Get-ChildItem -LiteralPath ${psQuote(staged)}).FullName; if (-not $items.Count) { throw 'Folder is empty' }; Compress-Archive -LiteralPath $items -DestinationPath ${psQuote(zipPath)} -CompressionLevel Optimal -Force`,
      ],
      { windowsHide: true, stdio: 'inherit' },
    );
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1000) {
    throw new Error(`Zip failed or too small: ${zipPath}`);
  }
  assertZipHasPhotoBooth(zipPath);
}

function main() {
  if (!fs.existsSync(unpacked)) {
    throw new Error(`Missing win-unpacked at ${unpacked}. Run electron-builder first.`);
  }
  if (!fs.existsSync(binDir)) {
    throw new Error(`Missing bin/ at ${binDir}. Place edsdk-bridge.exe + EDSDK DLLs there.`);
  }
  for (const f of NATIVE) {
    if (!fs.existsSync(path.join(binDir, f))) {
      throw new Error(`bin/${f} is required for Canon SDK support.`);
    }
  }

  for (const f of NATIVE) {
    copyFile(path.join(binDir, f), path.join(unpacked, f));
  }
  assertNativeIn(unpacked, 'win-unpacked');

  const ts = stamp();
  fs.mkdirSync(buildsRoot, { recursive: true });

  const folderOut = path.join(buildsRoot, `ZYN-Photobooth-Folder-${version}-${ts}`);
  console.log(`[package-deploy] Copying folder build → ${folderOut}`);
  copyDir(unpacked, folderOut);
  const meta = writeVersionFile(folderOut, ts, 'folder');
  assertNativeIn(folderOut, 'folder build');

  const zipOut = path.join(buildsRoot, `ZYN-Photobooth-Folder-${version}-${ts}.zip`);
  console.log(`[package-deploy] Zipping OTA package → ${zipOut}`);
  zipFolder(folderOut, zipOut);
  console.log(
    `[package-deploy] Folder build stamped v${meta.version} build ${meta.buildId}.`,
  );

  if (fs.existsSync(portableExe)) {
    const portableDir = path.join(buildsRoot, `ZYN-Photobooth-Portable-${version}-${ts}`);
    fs.mkdirSync(portableDir, { recursive: true });
    const portableName = `ZYN-Photobooth-Portable-${version}-${ts}.exe`;
    copyFile(portableExe, path.join(portableDir, portableName));
    copyFile(portableExe, path.join(buildsRoot, portableName));
    for (const f of NATIVE) {
      copyFile(path.join(binDir, f), path.join(portableDir, f));
    }
    copyDir(path.join(appRoot, 'config'), path.join(portableDir, 'config'));
    copyDir(path.join(appRoot, 'themes'), path.join(portableDir, 'themes'));
    if (fs.existsSync(path.join(appRoot, 'theme-template'))) {
      copyDir(path.join(appRoot, 'theme-template'), path.join(portableDir, 'theme-template'));
    }
    writeVersionFile(portableDir, ts, 'portable');
    assertNativeIn(portableDir, 'portable package');
    console.log(`[package-deploy] Portable package → ${portableDir}`);
    console.log(`[package-deploy] Flat portable exe → ${path.join(buildsRoot, portableName)}`);
    console.log(
      '[package-deploy] Note: OTA self-update supports Folder builds only (not portable exe).',
    );
  } else {
    console.warn(`[package-deploy] Portable exe not found at ${portableExe}`);
  }

  console.log('[package-deploy] Done.');
  console.log(
    '[package-deploy] For Canon DSLR on tablets/kiosks, prefer the Folder build (ZYN-Photobooth.exe + edsdk-bridge beside it).',
  );
}

main();
