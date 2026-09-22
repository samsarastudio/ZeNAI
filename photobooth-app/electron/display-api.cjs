const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

function matchesFilter(job, display) {
  if (!job || job.aiStatus !== 'done' || !job.aiPath || !fs.existsSync(job.aiPath)) return false;
  const excluded = Array.isArray(display.excludedIds) ? display.excludedIds : [];
  if (excluded.includes(job.id)) return false;
  const filter = display.filter || 'today';
  if (filter === 'picked') {
    const picked = Array.isArray(display.pickedIds) ? display.pickedIds : [];
    return picked.includes(job.id) || job.displayPicked === true && picked.length === 0;
  }
  if (job.displayPicked === false) return false;
  if (filter === 'all') return true;
  if (filter === 'tags') {
    const want = (display.tags || []).map((t) => String(t).toLowerCase());
    if (!want.length) return true;
    const have = (job.tags || []).map((t) => String(t).toLowerCase());
    return want.some((t) => have.includes(t));
  }
  const created = Date.parse(job.createdAt || job.updatedAt || 0);
  if (filter === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return created >= start.getTime();
  }
  if (filter === 'range') {
    const from = display.rangeFrom ? Date.parse(display.rangeFrom) : 0;
    const to = display.rangeTo ? Date.parse(display.rangeTo) + 24 * 60 * 60 * 1000 : Date.now();
    return created >= from && created <= to;
  }
  return true;
}

function startDisplayApi(opts) {
  const { getConfig, listJobs, log } = opts;
  let server = null;
  let lastPort = null;

  function tokenOk(reqUrl) {
    const cfg = getConfig();
    const expected = String(cfg?.display?.apiToken || 'zyn-display');
    const q = reqUrl.query || {};
    const hdr = '';
    const got = String(q.token || '');
    return got && got === expected;
  }

  function json(res, code, body) {
    const data = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': Buffer.byteLength(data),
    });
    res.end(data);
  }

  function handler(req, res) {
    const parsed = url.parse(req.url, true);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }
    if (parsed.pathname === '/api/health') {
      json(res, 200, { ok: true });
      return;
    }
    if (!tokenOk(parsed)) {
      json(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }
    const cfg = getConfig();
    const display = cfg.display || {};
    if (parsed.pathname === '/api/display/settings') {
      json(res, 200, { ok: true, display });
      return;
    }
    if (parsed.pathname === '/api/display/feed') {
      const jobs = listJobs()
        .filter((j) => matchesFilter(j, display))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      json(res, 200, {
        ok: true,
        intervalMs: display.intervalMs || 8000,
        items: jobs.map((j) => ({
          id: j.id,
          createdAt: j.createdAt,
          canId: j.canId,
          canLabel: j.canLabel,
          tags: j.tags || [],
          imageUrl: `/api/media/${encodeURIComponent(j.id)}?token=${encodeURIComponent(display.apiToken || '')}`,
        })),
      });
      return;
    }
    const media = parsed.pathname && parsed.pathname.match(/^\/api\/media\/([^/]+)$/);
    if (media) {
      const id = decodeURIComponent(media[1]);
      const job = listJobs().find((j) => j.id === id);
      if (!job?.aiPath || !fs.existsSync(job.aiPath)) {
        json(res, 404, { ok: false, error: 'Not found' });
        return;
      }
      const ext = path.extname(job.aiPath).toLowerCase();
      const type = ext === '.png' ? 'image/png' : 'image/jpeg';
      const buf = fs.readFileSync(job.aiPath);
      res.writeHead(200, {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
      return;
    }
    json(res, 404, { ok: false, error: 'Not found' });
  }

  function listen() {
    const cfg = getConfig();
    const port = Number(cfg?.display?.apiPort) || 3040;
    if (server && lastPort === port) return;
    if (server) {
      try {
        server.close();
      } catch (_) {}
      server = null;
    }
    server = http.createServer(handler);
    server.listen(port, '0.0.0.0', () => {
      lastPort = port;
      log && log('info', 'display-api', `listening on ${port}`);
    });
    server.on('error', (e) => {
      log && log('error', 'display-api', String(e));
    });
  }

  listen();
  return { listen, matchesFilter };
}

module.exports = { startDisplayApi, matchesFilter };
