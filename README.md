# Photobooth-AICore

ZYN AI photobooth for Windows (Electron + Angular + optional Canon EDSDK).

## Apps

- `photobooth-app/` — kiosk, admin, AI/print pipeline, local display API
- `gallery-display/` — standalone Electron wall player
- `cloud-dashboard/` — **cloud upload host**: photos, guest email (SendGrid), OTA packages

## Guest flow

Attract → six ZYN cans → details/consent → capture → thank-you/reset.

AI, **cloud upload + email**, auto-print, and the gallery feed run in the background so the next guest is not blocked.

## Cloud dashboard (email + OTA)

This is a Node server, not inside the Windows exe. Start it first:

```bash
cd cloud-dashboard
copy .env.example .env
npm install
npm start
```

| URL | What |
|-----|------|
| http://127.0.0.1:3020/admin | Cloud dashboard (PIN **2727**) — photos, SendGrid, OTA |
| http://127.0.0.1:3020/ | Public wall of uploaded AI photos |
| http://127.0.0.1:3020/api/health | Health check |

Kiosk **Admin → Cloud**: enable upload, URL `http://127.0.0.1:3020` (or the host LAN/public URL), token `zyn-upload`.

**Email:** configure SendGrid on the cloud dashboard (**Admin → Email**). The kiosk uploads the AI file; the dashboard sends the mail.

**OTA:** upload a Folder zip on **Booth updates**, Roll out, then kiosk **Admin → System → Check for update**. Folder builds only (`ZYN-Photobooth.exe`).

## Develop vs standalone

Dev (needs Node + `ng serve`):

```bash
cd photobooth-app
npm run electron:dev
```

Standalone Windows app (no Angular server): double-click `ZYN-Photobooth.exe` in a Folder build under `builds/`, or from the app folder:

```bash
cd photobooth-app
npm run build
npm run electron:standalone
```

Gallery display is its own Windows app (`gallery-display/` → `ZYN-Gallery-Display.exe`). Point it at the kiosk (`http://127.0.0.1:3040`, token `zyn-display`) or at the cloud (`http://127.0.0.1:3020`, same display token).

Default admin PIN: `2727`.

Canon DSLR support needs `photobooth-app/bin/edsdk-bridge.exe`, `EDSDK.dll`, and `EdsImage.dll`. USB / system camera works without them.

## Admin / backend

- **Cloud / email / OTA:** `cloud-dashboard` at port 3020 (see above).
- **OpenAI:** kiosk Admin → System (API base URL including `/v1` + key).
- **Debug preview:** Admin → Debug → “Show generated image preview after AI”. When on, the kiosk waits for generation and shows capture vs AI so you can check compositions. Production guest flow still skips this.

## Build

```bash
cd photobooth-app
npm run electron:build:folder
```

Stamped folder builds land in `Photobooth-AICore/builds/` as `ZYN-Photobooth-Folder-<version>-<timestamp>/`.
