# ZYN Cloud dashboard

Photo upload host, guest email (SendGrid), and kiosk OTA packages.

This is the service the Windows kiosk talks to. It is not bundled inside `ZYN-Photobooth.exe`.

## Production server install

For a DigitalOcean / Linux host (systemd, firewall, Nginx/HTTPS, updates), see **[INSTALL.md](./INSTALL.md)**.

A ready-to-upload package is built as `builds/ZYN-Cloud-Dashboard-*-server-*.zip` (source only — no `node_modules`, `.env`, or `data/`).

## Run (this PC or a LAN/cloud host)

```bash
cd cloud-dashboard
copy .env.example .env
npm install
npm start
```

| URL | What |
|-----|------|
| http://127.0.0.1:3020/admin | Cloud dashboard (PIN `2727`) |
| http://127.0.0.1:3020/ | Public wall of uploaded AI photos |
| http://127.0.0.1:3020/api/health | Health |
| http://127.0.0.1:3020/api/frames | Frame sync + booth reachability probe |
| http://127.0.0.1:3020/api/display/feed?token=zyn-display | Feed for the gallery Windows app |

## First-time setup

1. Open `/admin` → **Email**: enable SendGrid, paste API key, set a verified From address.
2. **Settings**: set **Public base URL** (LAN/public host), copy the upload token (`zyn-upload` by default). Optionally enable **Auto-send AI uploads to the live gallery wall**.
3. On the kiosk: **Admin → Cloud** — enable upload, API URL matching that host, paste the same token.
4. After AI finishes, the kiosk uploads the photo here; **this server** emails the guest (when email is configured).

## OTA

1. Build a Folder zip (`photobooth-app` → `npm run electron:build:folder`).
2. Cloud admin → **Booth updates** → upload the zip (version/build auto-read from stamped zip) → **Roll out**.
   Or: `node scripts/register-booth-zip.mjs ..\builds\ZYN-Photobooth-Folder-….zip --rollout`
3. On the kiosk (Folder install): **Admin → System → Check for update → Install**.

OTA only works on Folder builds (`ZYN-Photobooth.exe` beside `version.json`), not portable exe / `ng serve`.
