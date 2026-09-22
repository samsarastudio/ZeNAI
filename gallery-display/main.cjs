const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('ZYN Gallery Display');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.zyn.photobooth.gallery');
}

function settingsPath() {
  const dir = path.join(app.getPath('userData'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'display-settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return { apiBase: 'http://127.0.0.1:3040', token: 'zyn-display' };
  }
}

function saveSettings(s) {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
}

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#0b1f18',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('display:getSettings', () => loadSettings());
  ipcMain.handle('display:saveSettings', (_e, s) => {
    const next = {
      apiBase: String(s?.apiBase || 'http://127.0.0.1:3040').replace(/\/$/, ''),
      token: String(s?.token || 'zyn-display'),
    };
    saveSettings(next);
    return next;
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
