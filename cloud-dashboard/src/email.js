import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { loadSettings } from './db.js';

export function emailConfig() {
  const s = loadSettings();
  return {
    enabled: !!s.emailEnabled,
    apiUrl: String(s.sendgridApiUrl || process.env.SENDGRID_API_URL || 'https://api.sendgrid.com/v3/mail/send').trim(),
    apiKey: String(s.sendgridApiKey || process.env.SENDGRID_API_KEY || '').trim(),
    from: String(s.emailFrom || process.env.EMAIL_FROM || '').trim(),
    fromName: String(s.emailFromName || process.env.EMAIL_FROM_NAME || 'ZYN Photobooth').trim(),
    subject: String(s.emailSubject || 'Your ZYN photo').trim(),
    body: String(s.emailBody || 'Thanks for visiting the ZYN photobooth. Your photo is attached.').trim(),
  };
}

export function sendPhotoEmail({ to, filePath, mime, filename }) {
  const cfg = emailConfig();
  if (!cfg.enabled) return Promise.reject(new Error('Email is disabled in cloud settings'));
  if (!cfg.apiKey || !cfg.from || !to || !filePath || !fs.existsSync(filePath)) {
    return Promise.reject(new Error('SendGrid is not configured or the photo file is missing'));
  }
  const content = fs.readFileSync(filePath).toString('base64');
  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: cfg.fromName ? { email: cfg.from, name: cfg.fromName } : { email: cfg.from },
    subject: cfg.subject,
    content: [{ type: 'text/plain', value: cfg.body }],
    attachments: [
      {
        content,
        type: mime || 'image/png',
        filename: filename || path.basename(filePath),
        disposition: 'attachment',
      },
    ],
  });
  return new Promise((resolve, reject) => {
    const u = new URL(cfg.apiUrl);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
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
          } catch {
            /* raw */
          }
          reject(new Error(`SendGrid HTTP ${res.statusCode}: ${detail}`));
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
