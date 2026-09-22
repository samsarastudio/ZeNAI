const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('displayApi', {
  getSettings: () => ipcRenderer.invoke('display:getSettings'),
  saveSettings: (s) => ipcRenderer.invoke('display:saveSettings', s),
});
