/**
 * Rebuild a valid OTA zip from an existing Folder build (via temp copy).
 * Usage: node scripts/rezip-folder.cjs [folderPath]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function zipFolder(folderPath, zipPath) {
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ota-zip-'));
  const staged = path.join(tmpRoot, 'payload');
  try {
    console.log('[rezip] staging copy…');
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
    } catch (_) {}
  }
  const listing = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${psQuote(zipPath)}); try { $n=$z.Entries.Count; $exe=($z.Entries | Where-Object { $_.FullName -match 'ZYN-Photobooth\\.exe$' } | Select-Object -ExpandProperty FullName) -join ','; Write-Output \"entries=$n\"; Write-Output $exe } finally { $z.Dispose() }`,
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  if (!/ZYN-Photobooth\.exe/i.test(listing)) {
    throw new Error('Zip missing ZYN-Photobooth.exe\n' + listing);
  }
  console.log(
    `[rezip] OK ${zipPath} (${Math.round(fs.statSync(zipPath).size / (1024 * 1024))} MB)\n${listing.trim()}`,
  );
}

const folder =
  process.argv[2] ||
  path.join(__dirname, '..', '..', 'builds', 'PhotoBooth-Folder-1.1.0-20260820-232309');
const dir = path.resolve(folder.replace(/\.zip$/i, ''));
const zip = `${dir}.zip`;
if (!fs.existsSync(dir)) throw new Error('Missing folder: ' + dir);
zipFolder(dir, zip);
