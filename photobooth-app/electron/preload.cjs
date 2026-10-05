const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pbApi', {
  getPaths: () => ipcRenderer.invoke('app:getPaths'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkBoothUpdate: (payload) => ipcRenderer.invoke('app:checkBoothUpdate', payload || {}),
  log: (payload) => ipcRenderer.invoke('app:log', payload),
  readLogTail: (payload) => ipcRenderer.invoke('app:readLogTail', payload || {}),
  openLogsFolder: () => ipcRenderer.invoke('app:openLogsFolder'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  onAppLogEntry: (cb) => {
    const handler = (_event, entry) => cb(entry);
    ipcRenderer.on('app:log-entry', handler);
    return () => ipcRenderer.removeListener('app:log-entry', handler);
  },
  cameraInvoke: (cmd) => ipcRenderer.invoke('camera:invoke', cmd),
  listCaptureHistory: (options) => ipcRenderer.invoke('capture:listHistory', options || {}),
  deleteCaptureHistory: (id) => ipcRenderer.invoke('capture:deleteHistory', id),
  readFileBase64: (filePath) => ipcRenderer.invoke('file:readBase64', filePath),
  readFileThumbBase64: (filePath, maxEdge) =>
    ipcRenderer.invoke('file:readThumbBase64', filePath, maxEdge),
  saveJpeg: (fullPath, base64Body) => ipcRenderer.invoke('file:saveJpeg', fullPath, base64Body),
  adminGetConfig: () => ipcRenderer.invoke('admin:getConfig'),
  adminSaveConfig: (partial) => ipcRenderer.invoke('admin:saveConfig', partial),
  adminTestOpenAiKey: (draftKey) => ipcRenderer.invoke('admin:testOpenAiKey', draftKey),
  adminListThemes: () => ipcRenderer.invoke('admin:listThemes'),
  adminGetThemeStylesheetUrl: () => ipcRenderer.invoke('admin:getThemeStylesheetUrl'),
  adminPickThemeZip: () => ipcRenderer.invoke('admin:pickThemeZip'),
  adminInstallThemeFromZip: (zipPath) => ipcRenderer.invoke('admin:installThemeFromZip', zipPath),
  adminExportThemeZip: (themeId) => ipcRenderer.invoke('admin:exportThemeZip', themeId),
  adminDeleteTheme: (themeId) => ipcRenderer.invoke('admin:deleteTheme', themeId),
  adminExportThemeTemplate: () => ipcRenderer.invoke('admin:exportThemeTemplate'),
  adminVerifyPin: (pin) => ipcRenderer.invoke('admin:verifyPin', pin),
  adminPickLogoImage: () => ipcRenderer.invoke('admin:pickLogoImage'),
  adminInstallLogo: (sourcePath) => ipcRenderer.invoke('admin:installLogo', sourcePath),
  adminClearLogo: () => ipcRenderer.invoke('admin:clearLogo'),
  adminGetBrandingLogoUrl: () => ipcRenderer.invoke('admin:getBrandingLogoUrl'),
  adminPickAiLogoImage: () => ipcRenderer.invoke('admin:pickAiLogoImage'),
  adminInstallAiLogo: (sourcePath) => ipcRenderer.invoke('admin:installAiLogo', sourcePath),
  adminClearAiLogo: () => ipcRenderer.invoke('admin:clearAiLogo'),
  adminGetAiBrandLogoUrl: () => ipcRenderer.invoke('admin:getAiBrandLogoUrl'),
  adminPickCameraOverlayImage: () => ipcRenderer.invoke('admin:pickCameraOverlayImage'),
  adminInstallCameraOverlay: (sourcePath) =>
    ipcRenderer.invoke('admin:installCameraOverlay', sourcePath),
  adminInstallBundledCameraOverlay: (kind) =>
    ipcRenderer.invoke('admin:installBundledCameraOverlay', kind),
  adminClearCameraOverlay: () => ipcRenderer.invoke('admin:clearCameraOverlay'),
  adminGetCameraOverlayUrl: () => ipcRenderer.invoke('admin:getCameraOverlayUrl'),
  adminListAiBackgrounds: (modeId) => ipcRenderer.invoke('admin:listAiBackgrounds', modeId),
  adminPickAiBackgroundImage: () => ipcRenderer.invoke('admin:pickAiBackgroundImage'),
  adminInstallAiBackground: (modeId, sourcePath) =>
    ipcRenderer.invoke('admin:installAiBackground', modeId, sourcePath),
  adminDeleteAiBackground: (modeId, filename) =>
    ipcRenderer.invoke('admin:deleteAiBackground', modeId, filename),
  adminListCompositions: () => ipcRenderer.invoke('admin:listCompositions'),
  adminGetComposition: (canId) => ipcRenderer.invoke('admin:getComposition', canId),
  adminPickCompositionImage: () => ipcRenderer.invoke('admin:pickCompositionImage'),
  adminInstallComposition: (canId, sourcePath) =>
    ipcRenderer.invoke('admin:installComposition', canId, sourcePath),
  adminSaveCompositionFace: (canId, face) =>
    ipcRenderer.invoke('admin:saveCompositionFace', canId, face),
  openAiGenerateImage: (payload) => ipcRenderer.invoke('openai:generateImage', payload),
  listPhotoFrames: () => ipcRenderer.invoke('frames:list'),
  applyPhotoFrame: (payload) => ipcRenderer.invoke('frames:apply', payload),
  applyPhysicalFrameLayout: (payload) =>
    ipcRenderer.invoke('layouts:physicalFrameDual', payload || {}),
  adminPickPhotoFrameImage: () => ipcRenderer.invoke('admin:pickPhotoFrameImage'),
  adminInstallPhotoFrame: (sourcePath) => ipcRenderer.invoke('admin:installPhotoFrame', sourcePath),
  adminDeletePhotoFrame: (filename) => ipcRenderer.invoke('admin:deletePhotoFrame', filename),
  galleryEnsureDaySession: (payload) => ipcRenderer.invoke('gallery:ensureDaySession', payload),
  galleryUploadPhoto: (payload) => ipcRenderer.invoke('gallery:uploadPhoto', payload),
  galleryFlushUploadQueue: () => ipcRenderer.invoke('gallery:flushUploadQueue'),
  galleryGetUploadQueueSummary: () => ipcRenderer.invoke('gallery:getUploadQueueSummary'),
  galleryResyncUploadQueue: (payload) => ipcRenderer.invoke('gallery:resyncUploadQueue', payload),
  galleryGetUploadQueueItem: (filePath) => ipcRenderer.invoke('gallery:getUploadQueueItem', filePath),
  onGalleryUploadQueueUpdated: (cb) => {
    const handler = (_event, item) => cb(item);
    ipcRenderer.on('gallery:upload-queue-updated', handler);
    return () => ipcRenderer.removeListener('gallery:upload-queue-updated', handler);
  },
  gallerySyncFrames: (payload) => ipcRenderer.invoke('gallery:syncFrames', payload),
  galleryPing: () => ipcRenderer.invoke('gallery:ping'),
  galleryPublishFrame: (payload) => ipcRenderer.invoke('gallery:publishFrame', payload),
  galleryDeleteRemoteFrame: (payload) => ipcRenderer.invoke('gallery:deleteRemoteFrame', payload),
  listPrinters: (payload) => ipcRenderer.invoke('print:listPrinters', payload || {}),
  repairSelphyUsb: () => ipcRenderer.invoke('print:repairSelphyUsb'),
  printPhoto: (payload) => ipcRenderer.invoke('print:photo', payload),
  printTest: () => ipcRenderer.invoke('print:test'),
  jobsEnqueue: (payload) => ipcRenderer.invoke('jobs:enqueue', payload),
  jobsList: () => ipcRenderer.invoke('jobs:list'),
  jobsGet: (id) => ipcRenderer.invoke('jobs:get', id),
  jobsPrintOp: (payload) => ipcRenderer.invoke('jobs:printOp', payload),
  jobsRetry: (payload) => ipcRenderer.invoke('jobs:retry', payload),
  jobsSetDisplayPicked: (payload) => ipcRenderer.invoke('jobs:setDisplayPicked', payload),
  jobsKick: () => ipcRenderer.invoke('jobs:kick'),
  onJobsUpdated: (cb) => {
    const handler = (_event, summary) => cb(summary);
    ipcRenderer.on('jobs:updated', handler);
    return () => ipcRenderer.removeListener('jobs:updated', handler);
  },
});
