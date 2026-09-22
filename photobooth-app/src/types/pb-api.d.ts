export interface PbPaths {
  portableRoot: string;
  captureDir: string;
  themesDir?: string;
  configPath?: string;
  logsDir?: string;
  logFile?: string;
  hasBridge: boolean;
  appVersion?: string;
  appBuildId?: string;
  appChannel?: string;
  canSelfUpdate?: boolean;
}

export interface PbCameraResult {
  ok: boolean;
  err?: number | string;
  msg?: string;
  path?: string;
  cameras?: string[];
  previewFileUrl?: string | null;
  imageBase64?: string | null;
  readErr?: string;
}

export interface PbCaptureHistoryItem {
  id: string;
  capturedAt: string;
  originalPath: string;
  framedPath?: string;
  displayPath: string;
  printPath: string;
  layoutMode?: 'physicalFrame';
  /** Physical cut sheet vs digital/framed capture. */
  kind: 'physical' | 'normal';
  label: string;
  hasPhysical?: boolean;
  hasFramed?: boolean;
}

export interface PhotoboothConfigPublic {
  activeThemeId: string;
  branding?: Record<string, unknown>;
  copy: Record<string, unknown>;
}

export interface PbThemeListItem {
  id: string;
  folder: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
}

export interface PbApi {
  getPaths(): Promise<PbPaths>;
  getVersion(): Promise<{
    ok: boolean;
    version?: string;
    buildId?: string;
    channel?: string;
    electronVersion?: string;
    installRoot?: string;
    canSelfUpdate?: boolean;
    error?: string;
  }>;
  checkBoothUpdate(payload?: {
    apply?: boolean;
  }): Promise<{
    ok: boolean;
    updateAvailable?: boolean;
    applying?: boolean;
    skipped?: boolean;
    reason?: string;
    local?: { version?: string; buildId?: string };
    active?: { version?: string; buildId?: string } | null;
    release?: { version?: string; buildId?: string };
    error?: string;
  }>;
  log(payload: {
    level?: 'info' | 'warn' | 'error' | 'debug';
    scope?: string;
    message: string;
    detail?: unknown;
    skipBroadcast?: boolean;
  }): Promise<{ ok: boolean; logFile?: string; error?: string }>;
  readLogTail(payload?: {
    maxLines?: number;
  }): Promise<{ ok: boolean; lines?: string[]; logFile?: string; error?: string }>;
  openLogsFolder(): Promise<{ ok: boolean; path?: string; error?: string }>;
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
  onAppLogEntry?(
    cb: (entry: {
      ts?: string;
      level?: string;
      scope?: string;
      message?: string;
      detail?: string;
    }) => void,
  ): () => void;
  cameraInvoke(cmd: Record<string, unknown>): Promise<PbCameraResult>;
  listCaptureHistory(options?: {
    limit?: number;
    maxAgeDays?: number;
  }): Promise<{
    ok: boolean;
    photos?: PbCaptureHistoryItem[];
    error?: string;
  }>;
  deleteCaptureHistory(id: string): Promise<{ ok: boolean; deleted?: string[]; error?: string }>;
  readFileBase64(filePath: string): Promise<string>;
  readFileThumbBase64(
    filePath: string,
    maxEdge?: number,
  ): Promise<string>;
  saveJpeg(fullPath: string, base64Body: string): Promise<{ ok: boolean; path?: string }>;
  adminGetConfig(): Promise<{ ok: boolean; config?: PhotoboothConfigPublic; error?: string }>;
  adminSaveConfig(
    partial: Record<string, unknown>,
  ): Promise<{ ok: boolean; config?: PhotoboothConfigPublic; error?: string }>;
  adminTestOpenAiKey(
    draftKey?: string,
  ): Promise<{ ok: boolean; message?: string; error?: string }>;
  adminListThemes(): Promise<{ ok: boolean; themes?: PbThemeListItem[]; error?: string }>;
  adminGetThemeStylesheetUrl(): Promise<{ ok: boolean; url?: string | null; error?: string }>;
  adminPickThemeZip(): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  adminInstallThemeFromZip(
    zipPath: string,
  ): Promise<{ ok: boolean; id?: string; error?: string }>;
  adminExportThemeZip(themeId: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  adminDeleteTheme(themeId: string): Promise<{
    ok: boolean;
    removedId?: string;
    switchedActiveToDefault?: boolean;
    error?: string;
  }>;
  adminExportThemeTemplate(): Promise<{ ok: boolean; path?: string; error?: string }>;
  adminVerifyPin(pin: string): Promise<{ ok: boolean; valid?: boolean; error?: string }>;
  adminPickLogoImage(): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  adminInstallLogo(
    sourcePath: string,
  ): Promise<{ ok: boolean; logoFile?: string; url?: string; error?: string }>;
  adminClearLogo(): Promise<{ ok: boolean; error?: string }>;
  adminGetBrandingLogoUrl(): Promise<{ ok: boolean; url?: string | null; error?: string }>;
  adminPickAiLogoImage(): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  adminInstallAiLogo(
    sourcePath: string,
  ): Promise<{ ok: boolean; aiLogoFile?: string; url?: string; error?: string }>;
  adminClearAiLogo(): Promise<{ ok: boolean; error?: string }>;
  adminGetAiBrandLogoUrl(): Promise<{ ok: boolean; url?: string | null; error?: string }>;
  adminListAiBackgrounds(modeId: string): Promise<{
    ok: boolean;
    modeId?: string;
    backgrounds?: { filename: string; url: string }[];
    error?: string;
  }>;
  adminPickAiBackgroundImage(): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  adminInstallAiBackground(
    modeId: string,
    sourcePath: string,
  ): Promise<{ ok: boolean; modeId?: string; filename?: string; url?: string; error?: string }>;
  adminDeleteAiBackground(
    modeId: string,
    filename: string,
  ): Promise<{ ok: boolean; removed?: string; error?: string }>;
  adminListCompositions(): Promise<{
    ok: boolean;
    items?: {
      ok?: boolean;
      canId?: string;
      url?: string | null;
      source?: string | null;
      filename?: string | null;
      face?: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number };
    }[];
    error?: string;
  }>;
  adminGetComposition(canId: string): Promise<{
    ok: boolean;
    canId?: string;
    url?: string | null;
    source?: string | null;
    filename?: string | null;
    face?: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number };
    error?: string;
  }>;
  adminPickCompositionImage(): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  adminInstallComposition(
    canId: string,
    sourcePath: string,
  ): Promise<{
    ok: boolean;
    canId?: string;
    url?: string | null;
    source?: string | null;
    filename?: string | null;
    face?: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number };
    error?: string;
  }>;
  adminSaveCompositionFace(
    canId: string,
    face: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number },
  ): Promise<{ ok: boolean; canId?: string; face?: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number }; error?: string }>;
  openAiGenerateImage(payload: {
    imagePath: string;
    prompt: string;
    modeId?: string;
    useInpainting?: boolean;
    randomizeBackground?: boolean;
    inpaintPrompt?: string;
    face?: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number };
  }): Promise<{
    ok: boolean;
    path?: string;
    model?: string;
    backgroundUsed?: string | null;
    inpainting?: boolean;
    brandApplied?: boolean;
    error?: string;
  }>;
  listPhotoFrames(): Promise<{
    ok: boolean;
    frames?: {
      filename: string;
      label: string;
      url: string;
      width?: number;
      height?: number;
      aspectRatio?: number | null;
      fitsGallery?: boolean;
    }[];
    error?: string;
  }>;
  applyPhotoFrame(payload: {
    imagePath: string;
    frameFile: string;
    photoScale?: number;
    cropZoom?: number;
    cropPanX?: number;
    cropPanY?: number;
    /** Guest caption drawn in the frame footer (after overlay). */
    guestText?: string;
    /** Optional credit under guest text. */
    creditLine?: string;
  }): Promise<{ ok: boolean; path?: string; frameFile?: string; error?: string }>;
  applyPhysicalFrameLayout(payload: {
    imagePath: string;
    cellWidthCm?: number;
    cellHeightCm?: number;
    innerPaddingMm?: number;
    safeInsetTopMm?: number;
    safeInsetBottomMm?: number;
    safeInsetLeftMm?: number;
    safeInsetRightMm?: number;
    gapMm?: number;
    marginMm?: number;
    printerCropInsetMm?: number;
    borderEnabled?: boolean;
    cellWidthIn?: number;
    cellHeightIn?: number;
    gapIn?: number;
    marginIn?: number;
    dpi?: number;
    rotateDegrees?: 90 | -90;
    cropZoom?: number;
    cropPanX?: number;
    cropPanY?: number;
  }): Promise<{ ok: boolean; path?: string; error?: string }>;
  adminPickPhotoFrameImage(): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  adminInstallPhotoFrame(
    sourcePath: string,
  ): Promise<{
    ok: boolean;
    filename?: string;
    url?: string;
    width?: number;
    height?: number;
    aspectRatio?: number | null;
    fitsGallery?: boolean;
    error?: string;
  }>;
  adminDeletePhotoFrame(
    filename: string,
  ): Promise<{ ok: boolean; removed?: string; error?: string }>;
  galleryEnsureDaySession(payload: {
    apiBaseUrl: string;
    uploadToken: string;
    eventPrefix: string;
  }): Promise<{
    ok: boolean;
    slug?: string;
    galleryUrl?: string;
    expiresAt?: string;
    error?: string;
  }>;
  galleryUploadPhoto(payload: {
    apiBaseUrl: string;
    uploadToken: string;
    eventPrefix: string;
    filePath: string;
    variant: 'original' | 'framed' | 'ai' | 'physical';
  }): Promise<{
    ok: boolean;
    queued?: boolean;
    status?: string;
    slug?: string;
    photoId?: string;
    shareUrl?: string;
    url?: string;
    variant?: string;
    error?: string;
  }>;
  galleryFlushUploadQueue(): Promise<{
    ok: boolean;
    uploaded?: number;
    failed?: number;
    pending?: number;
    busy?: boolean;
    error?: string;
  }>;
  galleryGetUploadQueueSummary(): Promise<{
    ok: boolean;
    summary?: {
      uploadedOk: number;
      queued: number;
      pending: number;
      error: number;
      total: number;
      retryable: number;
    };
    error?: string;
  }>;
  galleryResyncUploadQueue(payload: {
    apiBaseUrl?: string;
    uploadToken?: string;
    eventPrefix?: string;
    includeOk?: boolean;
  }): Promise<{
    ok: boolean;
    uploaded?: number;
    failed?: number;
    pending?: number;
    discovered?: number;
    requeued?: number;
    skippedMissing?: number;
    before?: {
      uploadedOk: number;
      queued: number;
      pending: number;
      error: number;
      total: number;
      retryable: number;
    };
    after?: {
      uploadedOk: number;
      queued: number;
      pending: number;
      error: number;
      total: number;
      retryable: number;
    };
    error?: string;
  }>;
  galleryGetUploadQueueItem(filePath: string): Promise<{
    ok: boolean;
    item?: {
      filePath: string;
      variant: string;
      status: string;
      photoId?: string;
      shareUrl?: string;
      url?: string;
      error?: string;
    } | null;
    error?: string;
  }>;
  onGalleryUploadQueueUpdated?(
    cb: (item: {
      filePath: string;
      variant?: string;
      status?: string;
      photoId?: string;
      shareUrl?: string;
      url?: string;
      error?: string;
    }) => void,
  ): () => void;
  gallerySyncFrames(payload: {
    apiBaseUrl: string;
    uploadToken?: string;
    pushLocal?: boolean;
    pruneLocal?: boolean;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    offline?: boolean;
    synced?: string[];
    skipped?: string[];
    published?: string[];
    pruned?: string[];
    failed?: { filename: string; error: string }[];
    count?: number;
    skippedCount?: number;
    publishedCount?: number;
    prunedCount?: number;
    error?: string;
  }>;
  galleryPing(): Promise<{
    ok: boolean;
    enabled?: boolean;
    reachable?: boolean;
    skipped?: boolean;
    apiBaseUrl?: string;
    error?: string;
  }>;
  galleryPublishFrame(payload: {
    apiBaseUrl: string;
    uploadToken: string;
    filename: string;
  }): Promise<{ ok: boolean; frame?: { filename: string }; error?: string }>;
  galleryDeleteRemoteFrame(payload: {
    apiBaseUrl: string;
    uploadToken: string;
    filename: string;
  }): Promise<{ ok: boolean; removed?: string; error?: string }>;
  listPrinters(payload?: { allowWifi?: boolean }): Promise<{
    ok: boolean;
    printers?: {
      name: string;
      displayName: string;
      description: string;
      isDefault: boolean;
      status: number;
      driverName?: string;
      portName?: string;
      /** Wi‑Fi / network IPP / WSD */
      isIppClass?: boolean;
      /** Microsoft IPP Class Driver (USB or Wi‑Fi) */
      usesIppDriver?: boolean;
      /** Real Canon / SELPHY driver or Canon queue name */
      isCanonDriver?: boolean;
      /** DNP / DS-RX1 driver or queue name */
      isDnpDriver?: boolean;
      /** Local USB port (USB001 / DOT4_*) */
      isUsb?: boolean;
      /** Network / Wi‑Fi / WSD / IPP port */
      isNetwork?: boolean;
    }[];
    usbCount?: number;
    totalCount?: number;
    selphyUsb?: {
      present?: boolean;
      code28?: boolean;
      usbPrintOk?: boolean;
      needsRepair?: boolean;
      queueName?: string | null;
      queueDriver?: string | null;
      queuePort?: string | null;
      usesIppDriver?: boolean;
    };
    repair?: { ok?: boolean; reason?: string; needsReboot?: boolean };
    error?: string;
  }>;
  repairSelphyUsb(): Promise<{
    ok: boolean;
    repair?: {
      ok?: boolean;
      reason?: string;
      needsReboot?: boolean;
      via?: string;
    };
    printers?: { name: string; driverName?: string; portName?: string }[];
    error?: string;
  }>;
  printPhoto(payload: {
    filePath: string;
    deviceName?: string | null;
    /** Dual-column physical frame cut sheet — one postcard with both photos. */
    layoutMode?: 'physicalFrame';
  }): Promise<{ ok: boolean; deviceName?: string | null; paper?: string | null; error?: string }>;
  printTest(): Promise<{ ok: boolean; deviceName?: string | null; paper?: string | null; error?: string }>;
  jobsEnqueue(payload: {
    capturePath: string;
    canId?: string | null;
    canLabel?: string | null;
    email?: string;
    firstName?: string;
    lastName?: string;
    consents?: Record<string, boolean>;
    tags?: string[];
  }): Promise<{ ok: boolean; job?: Record<string, unknown>; error?: string }>;
  jobsGet(id: string): Promise<{ ok: boolean; job?: Record<string, unknown>; error?: string }>;
  jobsList(): Promise<{
    ok: boolean;
    jobs?: Record<string, unknown>[];
    summary?: Record<string, number>;
    error?: string;
  }>;
  jobsPrintOp(payload: {
    id: string;
    op: 'retry' | 'cancel' | 'skip' | 'top' | 'reprint';
  }): Promise<{ ok: boolean; error?: string }>;
  jobsSetDisplayPicked(payload: { id: string; picked: boolean }): Promise<{ ok: boolean; error?: string }>;
  jobsKick(): Promise<{ ok: boolean; summary?: Record<string, number>; error?: string }>;
  onJobsUpdated?(cb: (summary: Record<string, number>) => void): () => void;
}

declare global {
  interface Window {
    pbApi?: PbApi;
  }
}

export {};
