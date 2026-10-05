# ZYN Cloud Dashboard — Server Install

Node backend for the ZYN photobooth: photo upload host and kiosk OTA packages.

| Item | Value |
|------|--------|
| App | `zyn-cloud-dashboard` |
| Default port | `3020` |
| Node | **20+** (LTS) |
| Admin UI | `http://HOST:3020/admin` (PIN `2727` by default) |
| Health | `http://HOST:3020/api/health` |

This service is **not** inside the Windows kiosk exe. Run it on a always-on Linux host (DigitalOcean, etc.), then point each kiosk at it under **Admin → Cloud**.

---

## 1. Server prerequisites (Ubuntu 22.04 / 24.04)

```bash
sudo apt update
sudo apt install -y curl build-essential python3 unzip

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node -v   # should be v20.x or newer
npm -v
```

`better-sqlite3` needs compile tools (`build-essential` + `python3`).

Open the firewall (DigitalOcean Cloud Firewall and/or UFW):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 3020/tcp
# Optional if you put Nginx in front later:
# sudo ufw allow 80/tcp
# sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

---

## 2. Unpack this zip

```bash
sudo mkdir -p /opt/zyn-cloud-dashboard
sudo chown "$USER":"$USER" /opt/zyn-cloud-dashboard

cd /tmp
unzip -o ZYN-Cloud-Dashboard-*-server.zip -d /opt/zyn-cloud-dashboard
cd /opt/zyn-cloud-dashboard
```

If the zip extracted into a nested folder, `cd` into that folder so `package.json` is in the current directory.

---

## 3. Configure environment

```bash
cp .env.example .env
nano .env
```

Minimum production settings (replace with your real public IP or domain):

```env
PORT=3020
HOST=0.0.0.0
ALLOW_LOCAL_PUBLIC_URL=0
PUBLIC_BASE_URL=http://YOUR_PUBLIC_IP:3020

UPLOAD_TOKEN=zyn-upload
ADMIN_PIN=2727
```

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP listen port (default `3020`) |
| `HOST` | Bind address — use `0.0.0.0` for remote access |
| `PUBLIC_BASE_URL` | URL kiosks and guests use (no trailing slash) |
| `ALLOW_LOCAL_PUBLIC_URL` | Set `0` in production so a localhost URL is not accepted as public |
| `UPLOAD_TOKEN` | Bearer token for kiosk uploads (must match kiosk **Admin → Cloud**) |
| `ADMIN_PIN` | PIN for `/admin` |
| `DATA_DIR` | Optional absolute path for SQLite + photos (default `./data`) |

Change `UPLOAD_TOKEN` and `ADMIN_PIN` before going live.

---

## 4. Install dependencies and start once

```bash
cd /opt/zyn-cloud-dashboard
npm install --omit=dev
npm start
```

In another session:

```bash
curl http://127.0.0.1:3020/api/health
```

Then open `http://YOUR_PUBLIC_IP:3020/admin` in a browser. Stop the foreground process with `Ctrl+C` once it looks healthy.

Runtime data is created under `./data/` (SQLite DB, photos, booth update zips, settings).

---

## 5. Run as a systemd service (recommended)

```bash
sudo tee /etc/systemd/system/zyn-cloud-dashboard.service > /dev/null <<'EOF'
[Unit]
Description=ZYN Cloud Dashboard
After=network.target

[Service]
Type=simple
User=YOUR_LINUX_USER
WorkingDirectory=/opt/zyn-cloud-dashboard
EnvironmentFile=/opt/zyn-cloud-dashboard/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
# Large OTA / photo uploads
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
```

Replace `YOUR_LINUX_USER` with the account that owns `/opt/zyn-cloud-dashboard` (for example `zyn-dev`).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zyn-cloud-dashboard
sudo systemctl status zyn-cloud-dashboard
sudo journalctl -u zyn-cloud-dashboard -f
```

Useful commands:

```bash
sudo systemctl restart zyn-cloud-dashboard
sudo systemctl stop zyn-cloud-dashboard
```

---

## 6. First-time product setup

1. Open `/admin` → unlock with `ADMIN_PIN`.
2. **Settings** — set **Public base URL** to `http://YOUR_PUBLIC_IP:3020` (or your HTTPS domain). Confirm upload token.
3. On each Windows kiosk: **Admin → Cloud**
   - Enable upload
   - API URL: same as `PUBLIC_BASE_URL`
   - Token: same as `UPLOAD_TOKEN`
4. Test: run a session → AI photo should appear under **Photos** in the cloud admin.

| URL | What |
|-----|------|
| `http://HOST:3020/admin` | Cloud dashboard |
| `http://HOST:3020/api/health` | Health check |

---

## 7. Optional: Nginx + HTTPS

Point a domain at the droplet, then:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/zyn-cloud > /dev/null <<'EOF'
server {
    listen 80;
    server_name your.domain.com;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3020;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/zyn-cloud /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your.domain.com
```

Update `.env`:

```env
PUBLIC_BASE_URL=https://your.domain.com
ALLOW_LOCAL_PUBLIC_URL=0
```

```bash
sudo systemctl restart zyn-cloud-dashboard
```

Also update kiosk **Admin → Cloud** to the HTTPS URL.

---

## 8. OTA booth updates

1. Build a Folder zip on a Windows build machine (`photobooth-app` → `npm run electron:build:folder`).
2. Cloud admin → **Booth updates** → upload the zip → **Roll out**.  
   Or from the app directory:

   ```bash
   node scripts/register-booth-zip.mjs /path/to/ZYN-Photobooth-Folder-….zip --rollout
   ```

3. On the kiosk (Folder install only): **Admin → System → Check for update → Install**.

OTA requires Folder builds (`ZYN-Photobooth.exe` beside `version.json`), not portable exe / `ng serve`.

---

## 9. Updating this backend later

```bash
sudo systemctl stop zyn-cloud-dashboard
cd /opt/zyn-cloud-dashboard

# Keep .env and data/ — unpack new zip over source files only
unzip -o /tmp/ZYN-Cloud-Dashboard-*-server.zip -d /tmp/zyn-new
# Copy src, public, scripts, package*.json from /tmp/zyn-new into this dir

npm install --omit=dev
sudo systemctl start zyn-cloud-dashboard
curl http://127.0.0.1:3020/api/health
```

Do **not** delete `data/` or `.env` unless you intend to wipe photos/settings.

---

## 10. Troubleshooting

| Symptom | Check |
|---------|--------|
| Can't reach from internet | Droplet running? Firewall allows TCP `3020`? `HOST=0.0.0.0`? `systemctl status` |
| `npm install` fails on sqlite | Install `build-essential` and `python3`, then retry |
| Kiosk upload 401 | `UPLOAD_TOKEN` must match kiosk Cloud token |
| Port in use | `ss -tlnp \| grep 3020` or change `PORT` |

Logs:

```bash
sudo journalctl -u zyn-cloud-dashboard -n 100 --no-pager
```

---

## Package contents

```
src/                 # Express API
public/              # Admin UI + gallery
scripts/             # OTA zip registration helper
package.json
package-lock.json
.env.example
README.md            # Product overview
INSTALL.md           # This file
```

Excluded from the zip (created on the server): `node_modules/`, `.env`, `data/`.
