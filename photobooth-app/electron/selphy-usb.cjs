'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TASK_NAME = 'PhotoBoothSelphyUsbRepair';
const REPAIR_COOLDOWN_MS = 45 * 1000;
const ELEVATE_DENY_MS = 6 * 60 * 60 * 1000;

let logger = () => {};
let getBundleRoot = () => __dirname;
let inFlight = null;
let lastRepairAt = 0;
let elevateDeniedUntil = 0;

function initSelphyUsb(opts) {
  if (typeof opts.appendAppLog === 'function') logger = opts.appendAppLog;
  if (typeof opts.getBundleRoot === 'function') getBundleRoot = opts.getBundleRoot;
}

function log(level, message, detail) {
  try {
    logger(level, 'selphy-usb', message, detail);
  } catch (_) {}
}

function isAsarVirtualPath(p) {
  const n = String(p || '').replace(/\//g, '\\').toLowerCase();
  return n.includes('\\app.asar\\') && !n.includes('\\app.asar.unpacked\\');
}

function findRepairScriptSource() {
  const unpackedDir = String(__dirname).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const candidates = [
    path.join(String(getBundleRoot() || ''), 'selphy-usb-repair.ps1'),
    path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'selphy-usb-repair.ps1'),
    path.join(unpackedDir, 'selphy-usb-repair.ps1'),
    path.join(__dirname, 'selphy-usb-repair.ps1'),
    path.join(String(getBundleRoot() || ''), 'electron', 'selphy-usb-repair.ps1'),
    path.join(String(getBundleRoot() || ''), 'resources', 'app.asar.unpacked', 'electron', 'selphy-usb-repair.ps1'),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && !isAsarVirtualPath(p)) return p;
    } catch (_) {}
  }
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

/** PowerShell cannot read files inside app.asar. Copy to a real disk path first. */
function getSelphyRepairScriptPath() {
  const src = findRepairScriptSource();
  if (!src) return null;
  const destDirs = [];
  if (process.env.LOCALAPPDATA) destDirs.push(path.join(process.env.LOCALAPPDATA, 'PhotoBooth'));
  destDirs.push(path.join(os.tmpdir(), 'PhotoBooth'));
  const bundleRoot = String(getBundleRoot() || '').trim();
  if (bundleRoot && !isAsarVirtualPath(bundleRoot)) destDirs.push(bundleRoot);
  let lastErr = null;
  for (const dir of destDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, 'selphy-usb-repair.ps1');
      if (path.resolve(src) !== path.resolve(dest) || isAsarVirtualPath(src)) {
        fs.writeFileSync(dest, fs.readFileSync(src));
      }
      if (fs.existsSync(dest) && !isAsarVirtualPath(dest)) return dest;
    } catch (e) {
      lastErr = e;
    }
  }
  if (src && !isAsarVirtualPath(src)) return src;
  if (lastErr) log('warn', 'could not materialize repair script', String(lastErr));
  return null;
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || '').replace(/\u0000/g, '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch (_) {}
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function runPs1(action, extra = {}) {
  const script = getSelphyRepairScriptPath();
  if (!script || !fs.existsSync(script) || isAsarVirtualPath(script)) {
    throw new Error('SELPHY repair script is missing from the booth package (not on disk).');
  }
  log('info', 'selphy repair script', script);
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Action',
      action,
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: extra.timeoutMs || 45000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const parsed = parseJsonFromStdout(stdout);
  if (!parsed) {
    const tail = String(stderr || stdout || '').trim().slice(0, 400);
    throw new Error(tail || `SELPHY ${action} returned no status.`);
  }
  return parsed;
}

async function probeSelphyUsb() {
  if (process.platform !== 'win32') {
    return { present: false, needsRepair: false, skipped: true, reason: 'not-windows' };
  }
  try {
    return await runPs1('Probe', { timeoutMs: 25000 });
  } catch (e) {
    log('warn', 'probe failed', String(e?.message || e));
    return { present: false, needsRepair: false, ok: false, error: String(e?.message || e) };
  }
}

async function taskExists() {
  try {
    await execFileAsync('schtasks.exe', ['/Query', '/TN', TASK_NAME], {
      windowsHide: true,
      timeout: 10000,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function runScheduledRepair() {
  await execFileAsync('schtasks.exe', ['/Run', '/TN', TASK_NAME], {
    windowsHide: true,
    timeout: 15000,
  });
  const deadline = Date.now() + 35000;
  let probe = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    probe = await probeSelphyUsb();
    if (!probe.needsRepair) {
      return { ok: true, repaired: true, reason: 'ok', via: 'scheduled-task', probe };
    }
  }
  return {
    ok: !probe?.needsRepair,
    repaired: true,
    reason: probe?.needsRepair ? 'still-broken' : 'ok',
    needsReboot: !!probe?.needsRepair,
    via: 'scheduled-task',
    probe,
  };
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function runElevatedRegisterAndRepair() {
  const script = getSelphyRepairScriptPath();
  const wrapper = [
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(script)},'-Action','RegisterTask') -Verb RunAs -PassThru -Wait -WindowStyle Hidden`,
    'if ($null -eq $p) { exit 5 }',
    'exit $p.ExitCode',
  ].join('; ');
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapper], {
      windowsHide: true,
      timeout: 180000,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/canceled|cancelled|Access is denied|The operation was canceled/i.test(msg) || e?.code === 5) {
      elevateDeniedUntil = Date.now() + ELEVATE_DENY_MS;
      return { ok: false, repaired: false, reason: 'uac-declined', error: msg };
    }
    throw e;
  }
  const probe = await probeSelphyUsb();
  return {
    ok: !probe.needsRepair,
    repaired: true,
    reason: probe.needsRepair ? 'still-broken' : 'ok',
    needsReboot: !!probe.needsRepair,
    via: 'elevated',
    probe,
  };
}

async function repairSelphyUsb(opts = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, skipped: true, reason: 'not-windows' };
  }
  const elevateIfNeeded = opts.elevateIfNeeded === true;
  const force = opts.force === true;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const probe = await probeSelphyUsb();
      const connected =
        probe.present ||
        probe.usbPrintOk ||
        !!probe.queueName ||
        probe.code28 ||
        probe.otherDevices;
      if (!force && !connected) {
        return { ok: true, repaired: false, reason: 'printer-not-present', probe };
      }
      if (!probe.needsRepair && !force) {
        return { ok: true, repaired: false, reason: 'already-ok', probe };
      }
      if (!force && Date.now() - lastRepairAt < REPAIR_COOLDOWN_MS) {
        return { ok: !probe.needsRepair, repaired: false, reason: 'cooldown', probe };
      }
      lastRepairAt = Date.now();

      try {
        const direct = await runPs1('Repair', { timeoutMs: 120000 });
        if (direct && direct.reason !== 'access-denied') {
          log('info', 'selphy USB repair (direct)', direct);
          return { ...direct, via: 'direct' };
        }
      } catch (e) {
        const msg = String(e?.message || e);
        if (!/Access is denied|exit code 5/i.test(msg)) {
          log('warn', 'direct repair failed', msg);
        }
      }

      if (await taskExists()) {
        try {
          const scheduled = await runScheduledRepair();
          log('info', 'selphy USB repair (scheduled task)', scheduled);
          return scheduled;
        } catch (e) {
          log('warn', 'scheduled repair failed', String(e?.message || e));
        }
      }

      if (elevateIfNeeded && Date.now() > elevateDeniedUntil) {
        log('info', 'selphy USB repair requesting elevation');
        const elevated = await runElevatedRegisterAndRepair();
        log('info', 'selphy USB repair (elevated)', elevated);
        return elevated;
      }

      return {
        ok: false,
        repaired: false,
        reason: elevateIfNeeded ? 'needs-elevation' : 'needs-admin',
        probe,
      };
    } catch (e) {
      const msg = String(e?.message || e);
      log('error', 'selphy USB repair failed', msg);
      return { ok: false, repaired: false, reason: 'error', error: msg };
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  initSelphyUsb,
  probeSelphyUsb,
  repairSelphyUsb,
  getSelphyRepairScriptPath,
};
