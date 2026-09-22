const fs = require('fs');
const path = require('path');

const AI_TIMEOUT_MS = 120000;
const MAX_AI_ATTEMPTS = 3;
const MAX_EMAIL_ATTEMPTS = 3;
/** Soft cap before longer cooldown; jobs keep retrying so uploads/prints are not dropped. */
const MAX_PRINT_ATTEMPTS = 8;
const MAX_UPLOAD_ATTEMPTS = 12;
const FAILED_RETRY_MS = 60000;
const WATCHDOG_MS = 15000;

function nowIso() {
  return new Date().toISOString();
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function backoffMs(attempt) {
  return Math.min(30000, 1500 * Math.pow(2, Math.max(0, attempt - 1)));
}

function createJobPipeline(opts) {
  const {
    getStorePath,
    getConfig,
    generateAi,
    printPhoto,
    uploadJob,
    reportStatus,
    log,
    onJobsUpdated,
  } = opts;

  let aiRunning = false;
  let printRunning = false;
  let emailRunning = false;
  let uploadRunning = false;
  let kickTimer = null;

  function storePath() {
    return getStorePath();
  }

  function loadJobs() {
    try {
      const p = storePath();
      if (!fs.existsSync(p)) return { jobs: [] };
      let text = fs.readFileSync(p, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const raw = JSON.parse(text);
      if (!raw || !Array.isArray(raw.jobs)) return { jobs: [] };
      return raw;
    } catch {
      return { jobs: [] };
    }
  }

  function saveJobs(data) {
    const p = storePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  }

  function mutate(fn) {
    const data = loadJobs();
    const result = fn(data);
    saveJobs(data);
    try {
      onJobsUpdated && onJobsUpdated(summarize(data.jobs));
    } catch (_) {}
    return result;
  }

  function notifyCloud(jobOrId) {
    if (typeof reportStatus !== 'function') return;
    try {
      const job =
        typeof jobOrId === 'string'
          ? findJob(loadJobs().jobs, jobOrId)
          : jobOrId;
      if (!job) return;
      void Promise.resolve(reportStatus(clone(job))).catch((e) => {
        log && log('warn', 'jobs', 'cloud status push failed', String(e?.message || e));
      });
    } catch (_) {}
  }

  function findJob(jobs, id) {
    return jobs.find((j) => j.id === id);
  }

  function summarize(jobs) {
    const printPending = jobs.filter((j) => j.printStatus === 'queued' || j.printStatus === 'printing');
    const printFailed = jobs.filter((j) => j.printStatus === 'failed');
    const printDone = jobs.filter((j) => j.printStatus === 'done');
    return {
      total: jobs.length,
      aiQueued: jobs.filter((j) => j.aiStatus === 'queued').length,
      aiRunning: jobs.filter((j) => j.aiStatus === 'running').length,
      aiDone: jobs.filter((j) => j.aiStatus === 'done').length,
      aiFailed: jobs.filter((j) => j.aiStatus === 'failed').length,
      printPending: printPending.length,
      printFailed: printFailed.length,
      printDone: printDone.length,
      emailQueued: jobs.filter((j) => j.emailStatus === 'queued').length,
    };
  }

  function listJobs() {
    return clone(loadJobs().jobs);
  }

  function enqueueCapture(payload) {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      canId: payload.canId || null,
      canLabel: payload.canLabel || null,
      email: payload.email || '',
      firstName: payload.firstName || '',
      lastName: payload.lastName || '',
      consents: payload.consents || {},
      capturePath: payload.capturePath,
      aiPath: null,
      tags: payload.tags || (payload.canId ? [payload.canId] : []),
      displayPicked: true,
      aiStatus: 'queued',
      emailStatus: 'idle',
      uploadStatus: 'idle',
      printStatus: 'idle',
      printPriority: Date.now(),
      aiAttempts: 0,
      emailAttempts: 0,
      printAttempts: 0,
      uploadAttempts: 0,
      lastError: null,
      aiStartedAt: null,
    };
    mutate((data) => {
      data.jobs.push(job);
    });
    notifyCloud(job);
    log && log('info', 'jobs', 'enqueued capture', { id, canId: job.canId });
    kick();
    return clone(job);
  }

  function recoverStale() {
    mutate((data) => {
      for (const job of data.jobs) {
        if (job.aiStatus === 'running') {
          job.aiStatus = 'queued';
          job.aiStartedAt = null;
          job.updatedAt = nowIso();
          log && log('warn', 'jobs', 'recovered stale AI job', { id: job.id });
        }
        if (job.printStatus === 'printing') {
          job.printStatus = 'queued';
          job.updatedAt = nowIso();
        }
        if (job.emailStatus === 'sending') {
          job.emailStatus = 'queued';
          job.updatedAt = nowIso();
        }
        if (job.uploadStatus === 'uploading') {
          job.uploadStatus = 'queued';
          job.updatedAt = nowIso();
        }
      }
    });
  }

  function nextAiJob(jobs) {
    return jobs
      .filter((j) => j.aiStatus === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  }

  function nextPrintJob(jobs, cfg) {
    const auto = cfg?.print?.autoPrint !== false && cfg?.print?.enabled;
    const now = Date.now();
    return jobs
      .filter((j) => {
        if (j.printStatus !== 'queued' || !(auto || j.printManual)) return false;
        if (!j.aiPath) return false;
        const readyAt = Number(j.nextPrintAt || 0);
        return !Number.isFinite(readyAt) || readyAt <= now;
      })
      .sort((a, b) => (a.printPriority || 0) - (b.printPriority || 0))[0];
  }

  function nextEmailJob(jobs) {
    return jobs.filter((j) => j.emailStatus === 'queued')[0];
  }

  function nextUploadJob(jobs) {
    const now = Date.now();
    return jobs.filter((j) => {
      if (j.uploadStatus !== 'queued' || !j.aiPath) return false;
      const readyAt = Number(j.nextUploadAt || 0);
      return !Number.isFinite(readyAt) || readyAt <= now;
    })[0];
  }

  async function runUpload() {
    if (uploadRunning) return;
    const cfg = getConfig();
    const data = loadJobs();
    const job = nextUploadJob(data.jobs);
    if (!job || !job.aiPath) return;
    if (typeof uploadJob !== 'function') {
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.uploadStatus = 'skipped';
        j.updatedAt = nowIso();
      });
      return;
    }
    uploadRunning = true;
    mutate((d) => {
      const j = findJob(d.jobs, job.id);
      if (!j) return;
      j.uploadStatus = 'uploading';
      j.uploadAttempts = (j.uploadAttempts || 0) + 1;
      j.updatedAt = nowIso();
    });
    notifyCloud(job.id);
    try {
      const result = await uploadJob(job, cfg);
      if (!result?.ok) throw new Error(result?.error || 'Cloud upload failed');
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.uploadStatus = 'done';
        j.nextUploadAt = null;
        j.cloudPhotoId = result.photoId || null;
        j.cloudShareUrl = result.shareUrl || null;
        if (result.emailStatus) j.emailStatus = result.emailStatus;
        if (result.emailError) j.lastError = result.emailError;
        j.updatedAt = nowIso();
      });
      notifyCloud(job.id);
      log && log('info', 'jobs', 'cloud upload done', { id: job.id, photoId: result.photoId });
    } catch (e) {
      const msg = String(e?.message || e);
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.lastError = msg;
        j.updatedAt = nowIso();
        const attempts = j.uploadAttempts || 0;
        // Never drop cloud uploads — soft-reset after the soft cap and keep retrying.
        if (attempts >= MAX_UPLOAD_ATTEMPTS) {
          j.uploadAttempts = Math.max(0, MAX_UPLOAD_ATTEMPTS - 3);
          j.nextUploadAt = Date.now() + FAILED_RETRY_MS;
        } else {
          j.nextUploadAt = Date.now() + backoffMs(attempts);
        }
        j.uploadStatus = 'queued';
      });
      notifyCloud(job.id);
      log && log('error', 'jobs', 'cloud upload failed', { id: job.id, error: msg });
      const attempts = (job.uploadAttempts || 0) + 1;
      await new Promise((r) => setTimeout(r, backoffMs(Math.min(attempts, MAX_UPLOAD_ATTEMPTS))));
    } finally {
      uploadRunning = false;
      kick();
    }
  }

  async function runAi() {
    if (aiRunning) return;
    const cfg = getConfig();
    const data = loadJobs();
    const job = nextAiJob(data.jobs);
    if (!job) return;
    aiRunning = true;
    mutate((d) => {
      const j = findJob(d.jobs, job.id);
      if (!j) return;
      j.aiStatus = 'running';
      j.aiStartedAt = nowIso();
      j.aiAttempts = (j.aiAttempts || 0) + 1;
      j.updatedAt = nowIso();
    });
    notifyCloud(job.id);
    try {
      const can =
        (cfg.cans || []).find((c) => c.id === job.canId) ||
        (cfg.aiModes || []).find((c) => c.id === job.canId) ||
        {};
      const result = await Promise.race([
        generateAi({
          imagePath: job.capturePath,
          prompt: can.prompt || can.inpaintPrompt || 'HEAD SWAP ONLY. Replace the F1 driver head with the guest face. Keep this can\'s scene unchanged.',
          modeId: job.canId,
          useInpainting: true,
          randomizeBackground: false,
          inpaintPrompt: can.inpaintPrompt || can.prompt,
          face: can.face || null,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AI timed out')), AI_TIMEOUT_MS),
        ),
      ]);
      if (!result?.ok || !result.path) {
        throw new Error(result?.error || 'AI generation failed');
      }
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.aiStatus = 'done';
        j.aiPath = result.path;
        j.aiStartedAt = null;
        j.lastError = null;
        j.updatedAt = nowIso();
        const galleryOn = !!(cfg.gallery?.enabled && cfg.gallery?.apiBaseUrl && cfg.gallery?.uploadToken);
        const emailCfg = cfg.email || {};
        if (galleryOn) {
          j.uploadStatus = 'queued';
          j.emailStatus = j.email ? 'cloud' : 'skipped';
        } else if (emailCfg.enabled && j.email) {
          j.emailStatus = 'queued';
          j.uploadStatus = 'skipped';
        } else {
          j.emailStatus = 'skipped';
          j.uploadStatus = 'skipped';
        }
        if (cfg.print?.enabled && cfg.print?.autoPrint !== false) {
          j.printStatus = 'queued';
        } else if (!cfg.print?.enabled) {
          j.printStatus = 'skipped';
        }
      });
      notifyCloud(job.id);
      log && log('info', 'jobs', 'AI done', { id: job.id, path: result.path });
    } catch (e) {
      const msg = String(e?.message || e);
      const apiKeyMissing = /api key not configured|openai api key/i.test(msg);
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.aiStartedAt = null;
        j.lastError = apiKeyMissing
          ? 'OpenAI API key not configured. Set it in Admin → AI.'
          : msg;
        j.updatedAt = nowIso();
        if (apiKeyMissing || (j.aiAttempts || 0) >= MAX_AI_ATTEMPTS) {
          j.aiStatus = 'failed';
        } else {
          j.aiStatus = 'queued';
        }
      });
      notifyCloud(job.id);
      log && log('error', 'jobs', 'AI failed', { id: job.id, error: msg, apiKeyMissing });
      const attempts = (job.aiAttempts || 0) + 1;
      if (!apiKeyMissing && attempts < MAX_AI_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, backoffMs(attempts)));
      }
    } finally {
      aiRunning = false;
      kick();
    }
  }

  async function runPrint() {
    if (printRunning) return;
    const cfg = getConfig();
    const data = loadJobs();
    const job = nextPrintJob(data.jobs, cfg);
    if (!job || !job.aiPath) return;
    printRunning = true;
    mutate((d) => {
      const j = findJob(d.jobs, job.id);
      if (!j) return;
      j.printStatus = 'printing';
      j.printAttempts = (j.printAttempts || 0) + 1;
      j.printManual = false;
      j.updatedAt = nowIso();
    });
    notifyCloud(job.id);
    try {
      const result = await printPhoto({
        filePath: job.aiPath,
        timestamp: job.createdAt || null,
        jobId: job.id,
      });
      if (!result?.ok) throw new Error(result?.error || 'Print failed');
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.printStatus = 'done';
        j.lastPrintAt = nowIso();
        j.nextPrintAt = null;
        j.lastError = null;
        j.updatedAt = nowIso();
      });
      notifyCloud(job.id);
      log && log('info', 'jobs', 'print done', { id: job.id });
    } catch (e) {
      const msg = String(e?.message || e);
      const configFail =
        /no usable printer|printing is disabled|not installed|printer is not valid|configured printer/i.test(
          msg,
        );
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.lastError = msg;
        j.updatedAt = nowIso();
        const attempts = j.printAttempts || 0;
        if (configFail) {
          // Missing / disabled printer — stop retrying until admin fixes + reprint.
          j.printStatus = 'failed';
          j.nextPrintAt = null;
          return;
        }
        // Transient spooler issues — keep queued with backoff.
        if (attempts >= MAX_PRINT_ATTEMPTS) {
          j.printAttempts = Math.max(0, MAX_PRINT_ATTEMPTS - 3);
          j.nextPrintAt = Date.now() + FAILED_RETRY_MS;
        } else {
          j.nextPrintAt = Date.now() + backoffMs(attempts);
        }
        j.printStatus = 'queued';
      });
      notifyCloud(job.id);
      log && log('error', 'jobs', 'print failed', { id: job.id, error: msg, configFail });
      if (!configFail) {
        const attempts = (job.printAttempts || 0) + 1;
        await new Promise((r) => setTimeout(r, backoffMs(Math.min(attempts, MAX_PRINT_ATTEMPTS))));
      }
    } finally {
      printRunning = false;
      kick();
    }
  }

  async function sendSmtp(cfg, job) {
    const apiUrl = String(cfg.apiUrl || 'https://api.sendgrid.com/v3/mail/send').trim();
    const apiKey = String(cfg.apiKey || '').trim();
    const from = String(cfg.from || '').trim();
    const fromName = String(cfg.fromName || 'ZYN Photobooth').trim();
    const to = String(job.email || '').trim();
    const filePath = job.aiPath;
    if (!apiUrl || !apiKey || !from || !to || !filePath || !fs.existsSync(filePath)) {
      throw new Error('SendGrid is not configured or the AI file is missing.');
    }
    const content = fs.readFileSync(filePath).toString('base64');
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: fromName ? { email: from, name: fromName } : { email: from },
      subject: cfg.subject || 'Your ZYN photo',
      content: [{ type: 'text/plain', value: cfg.body || 'Your photobooth photo is attached.' }],
      attachments: [
        {
          content,
          type: mime,
          filename: path.basename(filePath),
          disposition: 'attachment',
        },
      ],
    };
    const https = require('https');
    await new Promise((resolve, reject) => {
      const u = new URL(apiUrl);
      const body = JSON.stringify(payload);
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
              return;
            }
            let detail = text.slice(0, 300);
            try {
              const j = JSON.parse(text);
              detail = j.errors?.[0]?.message || j.message || detail;
            } catch (_) {}
            reject(new Error(`SendGrid HTTP ${res.statusCode}: ${detail}`));
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function runEmail() {
    if (emailRunning) return;
    const cfg = getConfig();
    const data = loadJobs();
    const job = nextEmailJob(data.jobs);
    if (!job || !job.aiPath) return;
    emailRunning = true;
    mutate((d) => {
      const j = findJob(d.jobs, job.id);
      if (!j) return;
      j.emailStatus = 'sending';
      j.emailAttempts = (j.emailAttempts || 0) + 1;
      j.updatedAt = nowIso();
    });
    try {
      await sendSmtp(cfg.email || {}, job);
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.emailStatus = 'sent';
        j.updatedAt = nowIso();
      });
      log && log('info', 'jobs', 'email sent', { id: job.id });
    } catch (e) {
      const msg = String(e?.message || e);
      mutate((d) => {
        const j = findJob(d.jobs, job.id);
        if (!j) return;
        j.lastError = msg;
        j.updatedAt = nowIso();
        if ((j.emailAttempts || 0) >= MAX_EMAIL_ATTEMPTS) {
          j.emailStatus = 'failed';
        } else {
          j.emailStatus = 'queued';
        }
      });
      log && log('error', 'jobs', 'email failed', { id: job.id, error: msg });
    } finally {
      emailRunning = false;
      kick();
    }
  }

  function watchdog() {
    mutate((d) => {
      const cutoff = Date.now() - AI_TIMEOUT_MS - 5000;
      const now = Date.now();
      for (const j of d.jobs) {
        if (j.aiStatus === 'running' && j.aiStartedAt) {
          const started = Date.parse(j.aiStartedAt);
          if (Number.isFinite(started) && started <= cutoff) {
            j.aiStatus = (j.aiAttempts || 0) >= MAX_AI_ATTEMPTS ? 'failed' : 'queued';
            j.aiStartedAt = null;
            j.lastError = 'AI watchdog timeout';
            j.updatedAt = nowIso();
            log && log('warn', 'jobs', 'watchdog reset AI job', { id: j.id });
          }
        }
        // Re-queue any stuck/failed delivery so AI results still upload + print.
        if (j.aiStatus === 'done' && j.aiPath) {
          if (j.uploadStatus === 'failed') {
            j.uploadStatus = 'queued';
            j.uploadAttempts = 0;
            j.nextUploadAt = now;
            j.updatedAt = nowIso();
            log && log('warn', 'jobs', 'watchdog requeue failed upload', { id: j.id });
          }
          if (j.printStatus === 'failed') {
            // Keep failed — admin Reprint / Retry must clear this (avoids infinite loop on missing printer).
          }
          if (j.uploadStatus === 'uploading' && Date.parse(j.updatedAt || 0) < now - 120000) {
            j.uploadStatus = 'queued';
            j.updatedAt = nowIso();
          }
          if (j.printStatus === 'printing' && Date.parse(j.updatedAt || 0) < now - 180000) {
            j.printStatus = 'queued';
            j.updatedAt = nowIso();
          }
        }
      }
    });
    if (aiRunning) {
      const data = loadJobs();
      if (!data.jobs.some((j) => j.aiStatus === 'running')) {
        aiRunning = false;
      }
    }
    if (uploadRunning) {
      const data = loadJobs();
      if (!data.jobs.some((j) => j.uploadStatus === 'uploading')) {
        uploadRunning = false;
      }
    }
    if (printRunning) {
      const data = loadJobs();
      if (!data.jobs.some((j) => j.printStatus === 'printing')) {
        printRunning = false;
      }
    }
  }

  function kick() {
    if (kickTimer) return;
    kickTimer = setTimeout(() => {
      kickTimer = null;
      watchdog();
      void runAi().catch((e) => log && log('error', 'jobs', 'AI worker', String(e)));
      void runPrint().catch((e) => log && log('error', 'jobs', 'print worker', String(e)));
      void runEmail().catch((e) => log && log('error', 'jobs', 'email worker', String(e)));
      void runUpload().catch((e) => log && log('error', 'jobs', 'upload worker', String(e)));
    }, 50);
  }

  function printOp(id, op) {
    mutate((d) => {
      const j = findJob(d.jobs, id);
      if (!j) return;
      if (op === 'retry') {
        if (j.aiPath) {
          j.printStatus = 'queued';
          j.printManual = true;
          j.printAttempts = 0;
          j.nextPrintAt = null;
          j.lastError = null;
          if (j.uploadStatus === 'failed' || j.uploadStatus === 'idle') {
            j.uploadStatus = 'queued';
            j.uploadAttempts = 0;
            j.nextUploadAt = null;
          }
        }
      } else if (op === 'cancel' || op === 'skip') {
        if (j.printStatus === 'queued' || j.printStatus === 'failed') {
          j.printStatus = 'cancelled';
        }
      } else if (op === 'top') {
        j.printPriority = Date.now() - 1e12;
        if (j.printStatus === 'failed') j.printStatus = 'queued';
        j.printManual = true;
        j.nextPrintAt = null;
        j.lastError = null;
      } else if (op === 'reprint') {
        if (j.aiPath) {
          j.printStatus = 'queued';
          j.printManual = true;
          j.printAttempts = 0;
          j.printPriority = Date.now();
          j.nextPrintAt = null;
          j.lastError = null;
        }
      }
      j.updatedAt = nowIso();
    });
    kick();
    return { ok: true };
  }

  function setAutoPrint(enabled) {
    kick();
    return { ok: true, enabled: !!enabled };
  }

  function setDisplayPicked(id, picked) {
    mutate((d) => {
      const j = findJob(d.jobs, id);
      if (!j) return;
      j.displayPicked = !!picked;
      j.updatedAt = nowIso();
    });
    return { ok: true };
  }

  function start() {
    recoverStale();
    kick();
    setInterval(() => kick(), WATCHDOG_MS);
  }

  return {
    start,
    kick,
    enqueueCapture,
    getJob(id) {
      return clone(findJob(loadJobs().jobs, id) || null);
    },
    listJobs,
    printOp,
    setAutoPrint,
    setDisplayPicked,
    summarize: () => summarize(loadJobs().jobs),
  };
}

module.exports = { createJobPipeline };
