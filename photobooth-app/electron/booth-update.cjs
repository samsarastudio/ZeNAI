/**
 * Moments-hosted OTA updates for Folder builds (manual install only).
 *
 * Supported packaging / publish path (do not regress):
 * 1. `package-deploy.cjs` → Compress-Archive zip (not Windows `tar -a`)
 * 2. Moments Admin chunked multipart upload (or Pi `register-booth-zip.mjs` / scp)
 * 3. Booth Install → detached PowerShell apply (cmd `start`, lock retries, version.json verify)
 *
 * Booth Admin checks for a rolled-out package, then the operator confirms
 * Install — which downloads the zip and spawns a detached PowerShell script
 * that waits for PhotoBooth to exit, replaces files (preserving config /
 * capture / data / logs / updates), refreshes shipped scene images inside
 * config, relaunches, and cleans up.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const PRESERVE = new Set(['config', 'capture', 'data', 'logs', 'updates']);

function readLocalVersion(portableRoot, bundleRoot) {
  const candidates = [
    path.join(portableRoot, 'version.json'),
    path.join(bundleRoot, 'version.json'),
    path.join(__dirname, '..', 'version.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j?.version) {
        return {
          version: String(j.version),
          buildId: String(j.buildId || ''),
          channel: String(j.channel || ''),
          path: p,
        };
      }
    } catch (_) {
      /* ignore */
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return { version: String(pkg.version || '0.0.0'), buildId: '', channel: 'dev', path: null };
  } catch (_) {
    return { version: '0.0.0', buildId: '', channel: 'unknown', path: null };
  }
}

function canSelfUpdate(app, portableRoot) {
  if (!app?.isPackaged) return false;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return false;
  if (process.platform !== 'win32') return false;
  return fs.existsSync(path.join(portableRoot, 'ZYN-Photobooth.exe'));
}

function galleryBaseUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/$/, '');
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Windows often throws ENOTEMPTY on nested dirs (e.g. resources/) even with
 * recursive rmSync when files are briefly locked. Retry, then PowerShell.
 */
function rmDirRobust(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  const attempts = [
    () => fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }),
    () => {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Remove-Item -LiteralPath ${psQuote(dirPath)} -Recurse -Force -ErrorAction Stop`,
        ],
        { windowsHide: true, stdio: 'pipe' },
      );
    },
  ];
  let lastErr = null;
  for (const run of attempts) {
    try {
      run();
      if (!fs.existsSync(dirPath)) return;
    } catch (e) {
      lastErr = e;
    }
  }
  // Last resort: move aside so a fresh staging dir can be created
  if (fs.existsSync(dirPath)) {
    const trash = `${dirPath}.trash-${Date.now()}`;
    try {
      fs.renameSync(dirPath, trash);
      try {
        fs.rmSync(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (_) {
        /* leftover trash is harmless under updates/ */
      }
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  if (fs.existsSync(dirPath) && lastErr) throw lastErr;
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

function findPayloadRoot(stagingDir) {
  if (fs.existsSync(path.join(stagingDir, 'ZYN-Photobooth.exe'))) return stagingDir;
  try {
    for (const ent of fs.readdirSync(stagingDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const nested = path.join(stagingDir, ent.name);
      if (fs.existsSync(path.join(nested, 'ZYN-Photobooth.exe'))) return nested;
    }
  } catch (_) {}
  return stagingDir;
}

/** Stream a large Moments package to disk (avoid buffering ~150MB in RAM). */
function downloadToFile(url, destPath, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      {
        headers,
        timeout: 0,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadToFile(res.headers.location, destPath, headers).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => resolve({ shaHeader: res.headers['x-content-sha256'] || '' }));
        out.on('error', reject);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

function writeUpdaterScript({
  installRoot,
  stagingDir,
  zipPath,
  logPath,
  expectedVersion,
  expectedBuildId,
}) {
  const scriptPath = path.join(installRoot, 'updates', `apply-update-${Date.now()}.ps1`);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  const preserve = [...PRESERVE].map((p) => `'${p}'`).join(', ');
  const script = `
$ErrorActionPreference = 'Stop'
$InstallRoot = ${JSON.stringify(installRoot)}
$StagingDir = ${JSON.stringify(stagingDir)}
$ZipPath = ${JSON.stringify(zipPath)}
$LogPath = ${JSON.stringify(logPath)}
$ExpectedVersion = ${JSON.stringify(String(expectedVersion || ''))}
$ExpectedBuildId = ${JSON.stringify(String(expectedBuildId || ''))}
$Preserve = @(${preserve})

function Log($m) {
  $line = "$(Get-Date -Format o) $m"
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8 } catch {}
}

function Wait-Unlocked([string]$Path, [int]$Seconds = 60) {
  for ($t = 0; $t -lt $Seconds; $t++) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
      $fs = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
      $fs.Close()
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

function Copy-Tree([string]$Src, [string]$Dst) {
  New-Item -ItemType Directory -Force -Path $Dst | Out-Null
  & robocopy $Src $Dst /E /IS /IT /R:8 /W:2 /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw "robocopy failed code=$code src=$Src dest=$Dst" }
}

Log "updater started installRoot=$InstallRoot"
Log "expected v$ExpectedVersion build=$ExpectedBuildId"

# Wait until ZYN-Photobooth.exe process is gone (up to ~3 minutes)
for ($i = 0; $i -lt 180; $i++) {
  $procs = @(Get-Process -Name 'ZYN-Photobooth' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { break }
  if ($i -eq 0 -or ($i % 10) -eq 0) { Log ("waiting for ZYN-Photobooth exit; still running count=" + $procs.Count) }
  Start-Sleep -Seconds 1
}
Get-Process -Name 'edsdk-bridge','ZYN-Photobooth' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Log 'processes cleared'

$payload = $StagingDir
if (-not (Test-Path -LiteralPath (Join-Path $payload 'ZYN-Photobooth.exe'))) {
  Get-ChildItem -LiteralPath $StagingDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if (Test-Path -LiteralPath (Join-Path $_.FullName 'ZYN-Photobooth.exe')) { $payload = $_.FullName }
  }
}
Log "payload=$payload"
if (-not (Test-Path -LiteralPath (Join-Path $payload 'ZYN-Photobooth.exe'))) {
  Log 'FATAL: payload missing ZYN-Photobooth.exe'
  exit 2
}

# Prefer moving the running image aside so Replace is not blocked
$exeDest = Join-Path $InstallRoot 'ZYN-Photobooth.exe'
$exeBak = Join-Path $InstallRoot ('ZYN-Photobooth.exe.bak-' + (Get-Date -Format 'yyyyMMddHHmmss'))
if (Test-Path -LiteralPath $exeDest) {
  if (-not (Wait-Unlocked $exeDest 90)) { Log "WARN: exe still locked: $exeDest" }
  try {
    Move-Item -LiteralPath $exeDest -Destination $exeBak -Force
    Log "moved old exe -> $exeBak"
  } catch {
    Log "WARN: could not move old exe: $($_.Exception.Message)"
  }
}

Get-ChildItem -LiteralPath $payload -Force | ForEach-Object {
  if ($Preserve -contains $_.Name) {
    Log "preserve skip $($_.Name)"
    return
  }
  $dest = Join-Path $InstallRoot $_.Name
  if ($_.PSIsContainer) {
    Log "copy dir $($_.Name)"
    Copy-Tree $_.FullName $dest
  } else {
    Log "copy file $($_.Name)"
    $copied = $false
    for ($a = 1; $a -le 10; $a++) {
      try {
        Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
        $copied = $true
        break
      } catch {
        Log "retry $a copy $($_.Name): $($_.Exception.Message)"
        Start-Sleep -Seconds 1
      }
    }
    if (-not $copied) { throw "Failed to copy $($_.Name)" }
  }
}

# config/ is preserved so booth settings survive. Scene images inside it still
# have to be replaced or the new UI keeps showing the previous pictures.
$AssetDirs = @(
  'config\\compositions',
  'config\\ai-backgrounds',
  'config\\photo-frames'
)
foreach ($rel in $AssetDirs) {
  $src = Join-Path $payload $rel
  if (-not (Test-Path -LiteralPath $src)) {
    Log "asset skip missing $rel"
    continue
  }
  $dest = Join-Path $InstallRoot $rel
  Log "refresh asset $rel"
  Copy-Tree $src $dest
}

$verPath = Join-Path $InstallRoot 'version.json'
if (-not (Test-Path -LiteralPath $verPath)) {
  Log 'FATAL: version.json missing after copy'
  exit 3
}
try {
  $ver = Get-Content -LiteralPath $verPath -Raw | ConvertFrom-Json
  Log ("installed version.json => v" + $ver.version + " build=" + $ver.buildId)
  if ($ExpectedVersion -and $ver.version -ne $ExpectedVersion) {
    Log "FATAL: version mismatch got=$($ver.version) expected=$ExpectedVersion"
    exit 4
  }
} catch {
  Log "FATAL: cannot read version.json: $($_.Exception.Message)"
  exit 5
}

if (-not (Test-Path -LiteralPath $exeDest)) {
  Log 'FATAL: ZYN-Photobooth.exe missing after copy'
  exit 6
}

Log "starting $exeDest"
Start-Process -FilePath $exeDest -WorkingDirectory $InstallRoot
Start-Sleep -Seconds 4

# Cleanup only after relaunch attempt
Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $exeBak) {
  Remove-Item -LiteralPath $exeBak -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
Log 'updater done OK'
`;
  fs.writeFileSync(scriptPath, script.replace(/\n/g, '\r\n'), 'utf8');
  return scriptPath;
}

function spawnDetachedUpdater(scriptPath, cwd) {
  // `start` fully detaches so Electron exit cannot kill the updater.
  const child = spawn(
    process.env.ComSpec || 'cmd.exe',
    [
      '/c',
      'start',
      '',
      '/min',
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      scriptPath,
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd,
    },
  );
  child.unref();
  return child;
}

let applying = false;

async function pollAndApply(deps) {
  const {
    app,
    loadMergedConfig,
    getPortableRoot,
    getBundleRoot,
    appendAppLog,
    killBridge,
    apply = false,
  } = deps;
  if (applying) return { ok: true, skipped: true, reason: 'busy' };

  const portableRoot = getPortableRoot();
  const local = readLocalVersion(portableRoot, getBundleRoot());
  if (!canSelfUpdate(app, portableRoot)) {
    return { ok: true, skipped: true, reason: 'not-folder-build', local };
  }

  const cfg = loadMergedConfig();
  const base = galleryBaseUrl(cfg?.gallery?.apiBaseUrl);
  const token = String(cfg?.gallery?.uploadToken || '').trim();
  if (!base || !token || cfg?.gallery?.enabled === false) {
    return { ok: true, skipped: true, reason: 'gallery-not-configured', local };
  }

  const checkUrl =
    `${base}/api/booth-update/check?currentVersion=${encodeURIComponent(local.version)}` +
    `&buildId=${encodeURIComponent(local.buildId || '')}`;

  let checkRes;
  let checkData;
  try {
    checkRes = await fetch(checkUrl, { headers: { Authorization: `Bearer ${token}` } });
    checkData = await checkRes.json().catch(() => null);
  } catch (e) {
    appendAppLog?.('warn', 'booth-update', 'check failed', String(e));
    return { ok: false, error: String(e), local };
  }
  if (!checkRes.ok || !checkData?.ok) {
    return {
      ok: false,
      error: checkData?.error || `HTTP ${checkRes.status}`,
      local,
    };
  }
  if (!checkData.updateAvailable || !checkData.active?.id) {
    return { ok: true, updateAvailable: false, local, active: checkData.active || null };
  }

  const release = checkData.active;
  if (!apply) {
    appendAppLog?.('info', 'booth-update', 'update available (manual install)', {
      from: local,
      to: { version: release.version, buildId: release.buildId },
      installRoot: portableRoot,
    });
    return { ok: true, updateAvailable: true, local, active: release, release };
  }

  appendAppLog?.('info', 'booth-update', 'manual update — downloading', {
    from: local,
    to: { version: release.version, buildId: release.buildId },
    installRoot: portableRoot,
  });

  applying = true;
  try {
    const updatesDir = path.join(portableRoot, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    const zipPath = path.join(updatesDir, `incoming-${release.version}-${release.buildId}.zip`);
    const stagingDir = path.join(updatesDir, `staging-${release.version}-${release.buildId}`);
    rmDirRobust(stagingDir);
    // Clear any leftover .trash-* from prior failed cleans (best effort)
    try {
      for (const name of fs.readdirSync(updatesDir)) {
        if (!name.startsWith('staging-') || !name.includes('.trash-')) continue;
        rmDirRobust(path.join(updatesDir, name));
      }
    } catch (_) {}
    fs.mkdirSync(stagingDir, { recursive: true });
    if (fs.existsSync(zipPath)) {
      try {
        fs.unlinkSync(zipPath);
      } catch (_) {
        const bak = `${zipPath}.old-${Date.now()}`;
        try {
          fs.renameSync(zipPath, bak);
        } catch (e) {
          throw new Error(`Could not clear previous download zip: ${e.message || e}`);
        }
      }
    }

    const downloadUrl = `${base}/api/booth-update/download/${encodeURIComponent(release.id)}`;
    const { shaHeader } = await downloadToFile(downloadUrl, zipPath, {
      Authorization: `Bearer ${token}`,
    });

    const st = fs.statSync(zipPath);
    if (!st.size || st.size < 1000) {
      throw new Error(`Downloaded zip too small (${st.size} bytes)`);
    }
    if (release.bytes && Math.abs(st.size - Number(release.bytes)) > 64) {
      throw new Error(`Download size mismatch (got ${st.size}, expected ${release.bytes})`);
    }

    const expectedSha = release.sha256 || shaHeader || '';
    if (expectedSha) {
      const got = await sha256File(zipPath);
      if (got.toLowerCase() !== String(expectedSha).toLowerCase()) {
        throw new Error(`SHA-256 mismatch (expected ${expectedSha}, got ${got})`);
      }
    }

    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(stagingDir)} -Force`,
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    const payload = findPayloadRoot(stagingDir);
    if (!fs.existsSync(path.join(payload, 'ZYN-Photobooth.exe'))) {
      throw new Error('Downloaded package does not contain ZYN-Photobooth.exe');
    }
    const stagedVerPath = path.join(payload, 'version.json');
    if (fs.existsSync(stagedVerPath)) {
      const stagedVer = JSON.parse(fs.readFileSync(stagedVerPath, 'utf8'));
      if (release.version && stagedVer.version && stagedVer.version !== release.version) {
        throw new Error(
          `Staged version.json is ${stagedVer.version} but release is ${release.version}`,
        );
      }
    }

    const logPath = path.join(portableRoot, 'logs', 'booth-update.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} electron: spawning updater for v${release.version} into ${portableRoot}\n`,
      'utf8',
    );
    const scriptPath = writeUpdaterScript({
      installRoot: portableRoot,
      stagingDir,
      zipPath,
      logPath,
      expectedVersion: release.version,
      expectedBuildId: release.buildId,
    });

    appendAppLog?.('info', 'booth-update', 'quitting to apply update', {
      version: release.version,
      buildId: release.buildId,
      scriptPath,
      installRoot: portableRoot,
      logPath,
    });

    spawnDetachedUpdater(scriptPath, portableRoot);

    try {
      killBridge?.();
    } catch (_) {}

    // Give `start` time to launch PowerShell before this process dies.
    setTimeout(() => {
      app.exit(0);
    }, 1500);
    return { ok: true, applying: true, release, installRoot: portableRoot, logPath };
  } catch (e) {
    applying = false;
    appendAppLog?.('error', 'booth-update', 'apply failed', String(e));
    return { ok: false, error: String(e), local };
  }
}

module.exports = {
  readLocalVersion,
  canSelfUpdate,
  pollAndApply,
};
