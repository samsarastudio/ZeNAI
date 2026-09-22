# ZYN Gallery Display

Standalone fullscreen Electron player for the 98" / second-display PC.

1. Start the kiosk (`photobooth-app`) so the display API is listening (default port 3040).
2. In this folder: `npm install` then `npm start`.
3. Open settings (gear) and set the kiosk LAN URL plus the token from Admin → Display.

The player only reads curated feed settings from the kiosk. It does not capture or print.
