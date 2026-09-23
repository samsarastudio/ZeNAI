import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type {
  PhotoboothAiMode,
  PhotoboothGuestModesConfig,
  PhotoboothBranding,
  PhotoboothCameraConfig,
  PhotoboothCaptureConfig,
  PhotoboothCopy,
  PhotoboothDebugConfig,
  PhotoboothGalleryConfig,
  PhotoboothPhysicalFrameConfig,
  PhotoboothPrintConfig,
  PhotoboothEmailConfig,
  PhotoboothDisplayConfig,
  PhotoboothCan,
  PhotoboothFaceBox,
} from '../../models/photobooth-config.model';
import {
  NEWSPAPER_AI_PROMPT,
  DJ_INPAINT_PROMPT,
  DJ_PROMPT_ONLY,
  PHOTOBOOTH_DEFAULT_AI_MODES,
  PHOTOBOOTH_DEFAULT_BRANDING,
  PHOTOBOOTH_DEFAULT_CAMERA,
  PHOTOBOOTH_DEFAULT_CAPTURE,
  PHOTOBOOTH_DEFAULT_COPY,
  PHOTOBOOTH_DEFAULT_DEBUG,
  PHOTOBOOTH_DEFAULT_GALLERY,
  PHOTOBOOTH_DEFAULT_GUEST_MODES,
  PHOTOBOOTH_DEFAULT_PHYSICAL_FRAME,
  PHOTOBOOTH_DEFAULT_PRINT,
  PHOTOBOOTH_DEFAULT_EMAIL,
  PHOTOBOOTH_DEFAULT_DISPLAY,
  PHOTOBOOTH_DEFAULT_CANS,
  PHOTOBOOTH_DEFAULT_FACE,
  PHOTOBOOTH_DEFAULT_OPENAI_API_URL,
  PLAIN_PHOTO_MODE_ID,
} from '../../models/photobooth-config.model';
import { autoPhysicalSheetMm } from '../../models/physical-frame-layout';
import { BrandingLogoService } from '../../services/branding-logo.service';
import { BoothConfigService } from '../../services/booth-config.service';
import { BoothLogService } from '../../services/booth-log.service';
import { CapturePhotoBrowserComponent } from '../../components/capture-photo-browser/capture-photo-browser.component';
import { PrintTroubleDialogComponent } from '../../components/print-trouble-dialog/print-trouble-dialog.component';
import { CameraService } from '../../services/camera.service';
import { ThemeService } from '../../services/theme.service';
import { setAdminSession } from '../admin.guard';

interface ThemeListItem {
  id: string;
  folder: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
}

interface AiBackgroundItem {
  filename: string;
  url: string;
}

interface CanCompositionPreview {
  url: string | null;
  source: string | null;
  filename: string | null;
  face: PhotoboothFaceBox;
}

interface WebcamDeviceOption {
  deviceId: string;
  label: string;
}

interface PrinterOption {
  name: string;
  displayName: string;
  isDefault: boolean;
  driverName?: string;
  portName?: string;
  isIppClass?: boolean;
  usesIppDriver?: boolean;
  isCanonDriver?: boolean;
  isDnpDriver?: boolean;
  isUsb?: boolean;
  isNetwork?: boolean;
}

interface AdminFrameItem {
  filename: string;
  label: string;
  url: string;
  /** Shown on the guest frame picker. */
  guestEnabled: boolean;
  width?: number;
  height?: number;
  aspectRatio?: number | null;
  fitsGallery?: boolean;
}

interface BoothJobItem {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  canId?: string | null;
  canLabel?: string | null;
  aiStatus?: string;
  aiPhase?: string | null;
  aiPhaseLabel?: string | null;
  aiProgress?: number | null;
  aiModel?: string | null;
  aiStartedAt?: string | null;
  printStatus?: string;
  emailStatus?: string;
  uploadStatus?: string;
  lastError?: string | null;
  aiPath?: string | null;
  displayPicked?: boolean;
}

interface UploadQueueSummary {
  uploadedOk: number;
  queued: number;
  pending: number;
  error: number;
  total: number;
  retryable: number;
}

@Component({
  selector: 'pb-admin-dashboard',
  imports: [FormsModule, RouterLink, PrintTroubleDialogComponent, CapturePhotoBrowserComponent],
  templateUrl: './admin-dashboard.component.html',
  styleUrl: './admin-dashboard.component.scss',
})
export class AdminDashboardComponent implements OnInit, OnDestroy {
  tab:
    | 'copy'
    | 'themes'
    | 'branding'
    | 'camera'
    | 'frames'
    | 'modes'
    | 'gallery'
    | 'photos'
    | 'print'
    | 'jobs'
    | 'cans'
    | 'display'
    | 'email'
    | 'ai'
    | 'system'
    | 'debug' = 'copy';
  draft: PhotoboothCopy = structuredClone(PHOTOBOOTH_DEFAULT_COPY);
  draftCapture: PhotoboothCaptureConfig = structuredClone(PHOTOBOOTH_DEFAULT_CAPTURE);
  draftBranding: PhotoboothBranding = structuredClone(PHOTOBOOTH_DEFAULT_BRANDING);
  draftCamera: PhotoboothCameraConfig = structuredClone(PHOTOBOOTH_DEFAULT_CAMERA);
  draftGallery: PhotoboothGalleryConfig = structuredClone(PHOTOBOOTH_DEFAULT_GALLERY);
  draftPrint: PhotoboothPrintConfig = structuredClone(PHOTOBOOTH_DEFAULT_PRINT);
  draftEmail: PhotoboothEmailConfig = structuredClone(PHOTOBOOTH_DEFAULT_EMAIL);
  sendGridKeyDraft = '';
  draftOpenAiApiUrl = PHOTOBOOTH_DEFAULT_OPENAI_API_URL;
  draftDisplay: PhotoboothDisplayConfig = structuredClone(PHOTOBOOTH_DEFAULT_DISPLAY);
  draftCans: PhotoboothCan[] = structuredClone(PHOTOBOOTH_DEFAULT_CANS);
  displayTagsText = '';
  readonly jobItems = signal<BoothJobItem[]>([]);
  readonly jobSummary = signal<Record<string, number> | null>(null);
  readonly printHistoryWhen = signal<'all' | 'today' | 'range'>('all');
  readonly printHistoryFrom = signal('');
  readonly printHistoryTo = signal('');
  readonly printHistoryPage = signal(1);
  readonly printHistoryPageSize = 8;
  readonly historyPreviewId = signal<string | null>(null);
  readonly historyPreviewUrl = signal<string | null>(null);
  private jobsUnsub?: () => void;
  readonly queueJobs = computed(() =>
    this.jobItems().filter(
      (j) =>
        !!j.aiPath &&
        ['queued', 'printing', 'failed'].includes(String(j.printStatus || '')),
    ),
  );
  readonly historyJobs = computed(() => {
    const when = this.printHistoryWhen();
    const fromVal = this.printHistoryFrom();
    const toVal = this.printHistoryTo();
    const fromMs =
      when === 'today'
        ? new Date().setHours(0, 0, 0, 0)
        : when === 'range' && fromVal
          ? Date.parse(fromVal)
          : 0;
    const toMs =
      when === 'range' && toVal ? Date.parse(toVal) + 24 * 60 * 60 * 1000 : Date.now() + 1;
    return this.jobItems().filter((j) => {
      if (!j.aiPath) return false;
      const created = Date.parse(String(j.createdAt || 0));
      if (when === 'all') return true;
      if (!Number.isFinite(created)) return false;
      if (when === 'today') return created >= fromMs;
      return created >= fromMs && created <= toMs;
    });
  });
  readonly printHistoryPageCount = computed(() =>
    Math.max(1, Math.ceil(this.historyJobs().length / this.printHistoryPageSize)),
  );
  readonly historyPageItems = computed(() => {
    const size = this.printHistoryPageSize;
    const p = Math.min(this.printHistoryPage(), this.printHistoryPageCount());
    const start = (p - 1) * size;
    return this.historyJobs().slice(start, start + size);
  });
  /** Newest-first list for Admin → AI jobs (local booth pipeline). */
  readonly recentJobs = computed(() =>
    [...this.jobItems()].sort((a, b) =>
      String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')),
    ),
  );
  readonly jobThumbUrls = signal<Record<string, string>>({});
  draftDebug: PhotoboothDebugConfig = structuredClone(PHOTOBOOTH_DEFAULT_DEBUG);
  draftGuestModes: PhotoboothGuestModesConfig = structuredClone(PHOTOBOOTH_DEFAULT_GUEST_MODES);
  draftPhysicalFrame: PhotoboothPhysicalFrameConfig = structuredClone(
    PHOTOBOOTH_DEFAULT_PHYSICAL_FRAME,
  );
  installRootLabel = signal<string | null>(null);
  activeThemeId = 'default';
  draftAiEnabled = false;
  draftRequireQrUnlock = false;
  draftFramesEnabled = true;
  draftAutoApplyFrame = false;
  draftGuestAdjustPhoto = true;
  draftGuestTextEnabled = false;
  draftGuestTextOptional = true;
  draftGuestTextMaxLength = 36;
  draftGuestTextCreditLine = 'by inmoment photography';
  draftGuestTextXPercent = 50;
  draftGuestTextYPercent = 78;
  draftGuestTextSizePercent = 3.4;
  draftGuestTextColor = '#c9a36a';
  draftGuestTextCreditColor = '#d8c4a0';
  draftGuestTextAlign: 'left' | 'center' | 'right' = 'center';
  draftGuestTextBrush = false;
  draftGuestTextBrushOpacity = 0.22;
  draftPhotoScale = 1;
  draftDefaultFrameFile: string | null = 'onam-grma-2026.png';
  /** Empty = all frames on disk are offered to guests. */
  draftGuestFrameFiles: string[] = [];
  draftDefaultAiModeId: string | null = null;
  readonly plainPhotoModeId = PLAIN_PHOTO_MODE_ID;
  draftAiModes: PhotoboothAiMode[] = structuredClone(PHOTOBOOTH_DEFAULT_AI_MODES);
  /** Only sent on save when non-empty; replaces stored key. */
  openAiKeyDraft = '';
  hasBridge = signal(false);
  logFilePath = signal<string | null>(null);
  appVersionLabel = signal('…');
  canSelfUpdate = signal(false);
  updateBusy = signal(false);
  pendingUpdateLabel = signal<string | null>(null);
  sdkCameras = signal<string[]>([]);
  webcamDevices = signal<WebcamDeviceOption[]>([]);
  printers = signal<PrinterOption[]>([]);
  themes = signal<ThemeListItem[]>([]);
  photoFramesList = signal<AdminFrameItem[]>([]);
  aiBackgrounds = signal<Record<string, AiBackgroundItem[]>>({});
  compositions = signal<Record<string, CanCompositionPreview>>({});
  status = signal<string | null>(null);
  busy = signal(false);
  printTroubleErr = signal<string | null>(null);
  uploadQueueSummary = signal<UploadQueueSummary | null>(null);
  galleryForceResync = false;

  constructor(
    readonly booth: BoothConfigService,
    readonly branding: BrandingLogoService,
    private readonly camera: CameraService,
    readonly boothLog: BoothLogService,
    private readonly theme: ThemeService,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    this.syncFromService();
    void this.refreshThemes();
    void this.refreshAppVersion();
    void this.refreshJobs();
    this.jobsUnsub = window.pbApi?.onJobsUpdated?.(() => {
      void this.refreshJobs();
    });
  }

  ngOnDestroy(): void {
    this.jobsUnsub?.();
  }

  async refreshAppVersion(): Promise<void> {
    try {
      if (window.pbApi?.getVersion) {
        const r = await window.pbApi.getVersion();
        if (r.ok) {
          const build = r.buildId ? ` · build ${r.buildId}` : '';
          const ch = r.channel ? ` · ${r.channel}` : '';
          this.appVersionLabel.set(`v${r.version || '?'}${build}${ch}`);
          this.canSelfUpdate.set(!!r.canSelfUpdate);
          this.installRootLabel.set(r.installRoot || null);
          return;
        }
      }
      const paths = await window.pbApi?.getPaths?.();
      if (paths?.appVersion) {
        const build = paths.appBuildId ? ` · build ${paths.appBuildId}` : '';
        this.appVersionLabel.set(`v${paths.appVersion}${build}`);
        this.canSelfUpdate.set(!!paths.canSelfUpdate);
        this.installRootLabel.set(paths.portableRoot || null);
      } else {
        this.appVersionLabel.set('unknown');
        this.installRootLabel.set(null);
      }
    } catch {
      this.appVersionLabel.set('unknown');
      this.installRootLabel.set(null);
    }
  }

  async checkBoothUpdateNow(): Promise<void> {
    if (!window.pbApi?.checkBoothUpdate) {
      this.status.set('Update check requires Electron Folder build.');
      return;
    }
    this.updateBusy.set(true);
    this.status.set(null);
    this.pendingUpdateLabel.set(null);
    try {
      const r = await window.pbApi.checkBoothUpdate({ apply: false });
      if (r.skipped) {
        this.status.set(`Update check skipped (${r.reason || 'n/a'}).`);
        return;
      }
      if (!r.ok) {
        this.status.set(r.error || 'Update check failed.');
        return;
      }
      if (r.updateAvailable && r.release) {
        const build = r.release.buildId ? ` (${r.release.buildId})` : '';
        this.pendingUpdateLabel.set(`v${r.release.version}${build}`);
        this.status.set(`Update available: v${r.release.version}. Tap Install when ready.`);
        return;
      }
      this.status.set(
        r.active
          ? `Up to date (rolled out v${r.active.version}).`
          : 'No roll-out active on Moments.',
      );
    } catch (e) {
      this.status.set(String(e));
    } finally {
      this.updateBusy.set(false);
      void this.refreshAppVersion();
    }
  }

  async installBoothUpdateNow(): Promise<void> {
    if (!window.pbApi?.checkBoothUpdate) {
      this.status.set('Install requires Electron Folder build.');
      return;
    }
    const label = this.pendingUpdateLabel() || 'the available update';
    if (
      !confirm(
        `Install ${label} now?\n\nZYN Photobooth will quit, replace files, and relaunch. Config, captures, and data are kept.`,
      )
    ) {
      return;
    }
    this.updateBusy.set(true);
    this.status.set('Downloading update…');
    try {
      const r = await window.pbApi.checkBoothUpdate({ apply: true });
      if (r.applying) {
        this.status.set(
          `Updating to v${r.release?.version || '?'} — app will close and relaunch…`,
        );
        return;
      }
      if (r.skipped) {
        this.status.set(`Install skipped (${r.reason || 'n/a'}).`);
        return;
      }
      if (!r.ok) {
        this.status.set(r.error || 'Install failed.');
        return;
      }
      if (r.updateAvailable === false) {
        this.pendingUpdateLabel.set(null);
        this.status.set('No update to install.');
        return;
      }
      this.status.set('Unexpected update response.');
    } catch (e) {
      this.status.set(String(e));
    } finally {
      this.updateBusy.set(false);
      void this.refreshAppVersion();
    }
  }

  private syncFromService(): void {
    this.draft = structuredClone(this.booth.copy());
    this.draftCapture = structuredClone(this.booth.capture());
    this.activeThemeId = this.booth.activeThemeId();
    const cfg = this.booth.config();
    this.draftAiEnabled = cfg?.aiGenerationEnabled ?? false;
    this.draftRequireQrUnlock = cfg?.requireQrUnlock ?? false;
    this.draftFramesEnabled = cfg?.photoFrames?.enabled ?? true;
    this.draftAutoApplyFrame = cfg?.photoFrames?.autoApplyFrame ?? false;
    this.draftGuestAdjustPhoto = cfg?.photoFrames?.guestAdjustPhoto ?? true;
    this.draftGuestTextEnabled = cfg?.photoFrames?.guestTextEnabled ?? false;
    this.draftGuestTextOptional = cfg?.photoFrames?.guestTextOptional ?? true;
    this.draftGuestTextMaxLength = cfg?.photoFrames?.guestTextMaxLength ?? 36;
    this.draftGuestTextCreditLine = cfg?.photoFrames?.guestTextCreditLine ?? 'by inmoment photography';
    this.draftGuestTextXPercent = cfg?.photoFrames?.guestTextXPercent ?? 50;
    this.draftGuestTextYPercent = cfg?.photoFrames?.guestTextYPercent ?? 78;
    this.draftGuestTextSizePercent = cfg?.photoFrames?.guestTextSizePercent ?? 3.4;
    this.draftGuestTextColor = cfg?.photoFrames?.guestTextColor ?? '#c9a36a';
    this.draftGuestTextCreditColor = cfg?.photoFrames?.guestTextCreditColor ?? '#d8c4a0';
    this.draftGuestTextAlign = cfg?.photoFrames?.guestTextAlign ?? 'center';
    this.draftGuestTextBrush = cfg?.photoFrames?.guestTextBrush ?? false;
    this.draftGuestTextBrushOpacity = cfg?.photoFrames?.guestTextBrushOpacity ?? 0.22;
    this.draftPhotoScale = cfg?.photoFrames?.photoScale ?? 1;
    this.draftDefaultFrameFile = cfg?.photoFrames?.defaultFrameFile ?? null;
    this.draftGuestFrameFiles = [...(cfg?.photoFrames?.guestFrameFiles ?? [])];
    this.draftDefaultAiModeId = cfg?.defaultAiModeId ?? null;
    this.draftAiModes = structuredClone(cfg?.aiModes ?? PHOTOBOOTH_DEFAULT_AI_MODES);
    this.draftBranding = structuredClone(cfg?.branding ?? PHOTOBOOTH_DEFAULT_BRANDING);
    this.draftCamera = structuredClone(cfg?.camera ?? PHOTOBOOTH_DEFAULT_CAMERA);
    this.draftGallery = structuredClone(cfg?.gallery ?? PHOTOBOOTH_DEFAULT_GALLERY);
    this.draftPrint = structuredClone(cfg?.print ?? PHOTOBOOTH_DEFAULT_PRINT);
    this.draftEmail = structuredClone(cfg?.email ?? PHOTOBOOTH_DEFAULT_EMAIL);
    this.sendGridKeyDraft = '';
    this.draftOpenAiApiUrl = cfg?.openAiApiUrl || PHOTOBOOTH_DEFAULT_OPENAI_API_URL;
    this.draftDisplay = structuredClone(cfg?.display ?? PHOTOBOOTH_DEFAULT_DISPLAY);
    this.draftCans = structuredClone(cfg?.cans ?? PHOTOBOOTH_DEFAULT_CANS);
    this.displayTagsText = (this.draftDisplay.tags || []).join(', ');
    this.draftDebug = structuredClone(cfg?.debug ?? PHOTOBOOTH_DEFAULT_DEBUG);
    this.draftGuestModes = structuredClone(cfg?.guestModes ?? PHOTOBOOTH_DEFAULT_GUEST_MODES);
    this.draftPhysicalFrame = structuredClone(
      cfg?.physicalFrame ?? PHOTOBOOTH_DEFAULT_PHYSICAL_FRAME,
    );
    this.openAiKeyDraft = '';
  }

  setTab(
    t:
      | 'copy'
      | 'themes'
      | 'branding'
      | 'camera'
      | 'frames'
      | 'modes'
      | 'gallery'
      | 'photos'
      | 'print'
      | 'jobs'
      | 'cans'
      | 'display'
      | 'email'
      | 'ai'
      | 'system'
      | 'debug',
  ): void {
    this.tab = t;
    if (t === 'themes') {
      void this.refreshThemes();
    }
    if (t === 'jobs' || t === 'print') {
      void this.refreshJobs();
    }
    if (t === 'branding') {
      void this.branding.refreshAll();
    }
    if (t === 'camera') {
      void this.refreshCameraDevices();
    }
    if (t === 'frames') {
      void this.refreshPhotoFramesAndSync();
    }
    if (t === 'gallery') {
      void this.refreshUploadQueueSummary();
    }
    if (t === 'system') {
      void this.refreshAppVersion();
    }
    if (t === 'print' || t === 'display') {
      void this.refreshPrinters();
      void this.refreshJobs();
    }
    if (t === 'cans') {
      void this.refreshCompositions();
    }
    if (t === 'ai') {
      void this.refreshAllAiBackgrounds();
    }
    if (t === 'debug') {
      void this.refreshDebugPanel();
    }
  }

  async saveModes(): Promise<void> {
    this.busy.set(true);
    this.status.set(null);
    try {
      if (!this.draftGuestModes.defaultEnabled && !this.draftGuestModes.physicalFrameEnabled) {
        this.draftGuestModes.defaultEnabled = true;
      }
      const ok = await this.booth.save({
        guestModes: { ...this.draftGuestModes },
        physicalFrame: { ...this.draftPhysicalFrame },
      });
      const parts: string[] = [];
      if (this.draftGuestModes.defaultEnabled) parts.push('Digital frame');
      if (this.draftGuestModes.physicalFrameEnabled) parts.push('Physical frame');
      this.status.set(
        ok
          ? `Modes saved — guests can choose: ${parts.join(' · ')}.`
          : 'Failed to save modes.',
      );
      this.syncFromService();
    } finally {
      this.busy.set(false);
    }
  }

  async refreshPhotoFrames(): Promise<void> {
    if (!window.pbApi?.listPhotoFrames) {
      this.photoFramesList.set([]);
      return;
    }
    const r = await window.pbApi.listPhotoFrames();
    if (!r.ok || !r.frames) {
      this.photoFramesList.set([]);
      if (r.error) this.status.set(r.error);
      return;
    }
    const allow = this.draftGuestFrameFiles;
    const showNone = allow.includes('__none__');
    const showAll = allow.length === 0;
    this.photoFramesList.set(
      r.frames.map((f) => ({
        filename: f.filename,
        label: f.label || f.filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
        url: f.url,
        guestEnabled: showNone ? false : showAll || allow.includes(f.filename),
        width: f.width,
        height: f.height,
        aspectRatio: f.aspectRatio,
        fitsGallery: f.fitsGallery,
      })),
    );
    if (
      this.draftDefaultFrameFile &&
      !this.photoFramesList().some((f) => f.filename === this.draftDefaultFrameFile)
    ) {
      this.draftDefaultFrameFile = this.photoFramesList()[0]?.filename ?? null;
    }
  }

  frameSizeHint(f: AdminFrameItem): string | null {
    if (!f.width || !f.height) return null;
    const ar = f.aspectRatio ?? f.width / f.height;
    if (f.fitsGallery) return `${f.width}×${f.height} · 3:2 (fills gallery)`;
    if (ar > 1.65) {
      return `${f.width}×${f.height} · ~16:9 — gallery needs 3:2 (6×4, e.g. 1800×1200)`;
    }
    return `${f.width}×${f.height} · ${ar.toFixed(2)}:1 — gallery needs 3:2 (6×4)`;
  }

  toggleGuestFrame(filename: string, enabled: boolean): void {
    this.photoFramesList.update((list) =>
      list.map((f) => (f.filename === filename ? { ...f, guestEnabled: enabled } : f)),
    );
    const allOn = this.photoFramesList().every((f) => f.guestEnabled);
    const noneOn = this.photoFramesList().every((f) => !f.guestEnabled);
    if (allOn) {
      this.draftGuestFrameFiles = [];
    } else if (noneOn) {
      this.draftGuestFrameFiles = ['__none__'];
    } else {
      this.draftGuestFrameFiles = this.photoFramesList()
        .filter((f) => f.guestEnabled)
        .map((f) => f.filename);
    }
  }

  selectAllGuestFrames(): void {
    this.photoFramesList.update((list) => list.map((f) => ({ ...f, guestEnabled: true })));
    this.draftGuestFrameFiles = [];
  }

  clearGuestFrames(): void {
    this.photoFramesList.update((list) => list.map((f) => ({ ...f, guestEnabled: false })));
    this.draftGuestFrameFiles = ['__none__'];
  }

  captionDragActive = false;

  get captionPreviewFrameUrl(): string | null {
    const file = this.draftDefaultFrameFile;
    const list = this.photoFramesList();
    const hit = file ? list.find((f) => f.filename === file) : list.find((f) => f.guestEnabled) || list[0];
    return hit?.url ?? null;
  }

  get captionPreviewSizeEm(): number {
    return Math.max(0.7, Number(this.draftGuestTextSizePercent) / 3.4);
  }

  get captionBrushOpacityPct(): number {
    return Math.round(Number(this.draftGuestTextBrushOpacity) * 100);
  }

  startCaptionPreviewDrag(ev: PointerEvent): void {
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture?.(ev.pointerId);
    this.captionDragActive = true;
    this.applyCaptionPreviewPoint(ev, el);
  }

  moveCaptionPreviewDrag(ev: PointerEvent): void {
    if (!this.captionDragActive) return;
    this.applyCaptionPreviewPoint(ev, ev.currentTarget as HTMLElement);
  }

  endCaptionPreviewDrag(): void {
    this.captionDragActive = false;
  }

  private applyCaptionPreviewPoint(ev: PointerEvent, el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const x = ((ev.clientX - r.left) / r.width) * 100;
    const y = ((ev.clientY - r.top) / r.height) * 100;
    this.draftGuestTextXPercent = Math.round(Math.min(100, Math.max(0, x)));
    this.draftGuestTextYPercent = Math.round(Math.min(100, Math.max(0, y)));
  }

  async saveFrames(): Promise<void> {
    this.status.set(null);
    const enabled = this.photoFramesList().filter((f) => f.guestEnabled).map((f) => f.filename);
    let guestFrameFiles: string[];
    if (enabled.length === 0) {
      guestFrameFiles = ['__none__'];
    } else if (enabled.length === this.photoFramesList().length) {
      guestFrameFiles = [];
    } else {
      guestFrameFiles = enabled;
    }
    let defaultFrameFile = this.draftDefaultFrameFile;
    if (defaultFrameFile && enabled.length && !enabled.includes(defaultFrameFile)) {
      defaultFrameFile = enabled[0] ?? null;
    }
    this.busy.set(true);
    try {
      const ok = await this.booth.save({
        photoFrames: {
          enabled: this.draftFramesEnabled,
          autoApplyFrame: this.draftFramesEnabled && this.draftAutoApplyFrame,
          guestAdjustPhoto: this.draftFramesEnabled && this.draftGuestAdjustPhoto,
          photoScale: this.draftPhotoScale,
          defaultFrameFile: defaultFrameFile || null,
          guestFrameFiles,
          guestTextEnabled: this.draftFramesEnabled && this.draftGuestTextEnabled,
          guestTextOptional: this.draftGuestTextOptional,
          guestTextMaxLength: this.draftGuestTextMaxLength,
          guestTextCreditLine: this.draftGuestTextCreditLine,
          guestTextXPercent: Number(this.draftGuestTextXPercent),
          guestTextYPercent: Number(this.draftGuestTextYPercent),
          guestTextSizePercent: Number(this.draftGuestTextSizePercent),
          guestTextColor: this.draftGuestTextColor,
          guestTextCreditColor: this.draftGuestTextCreditColor,
          guestTextAlign: this.draftGuestTextAlign,
          guestTextBrush: this.draftGuestTextBrush,
          guestTextBrushOpacity: Number(this.draftGuestTextBrushOpacity),
        },
      });
      if (ok) {
        this.syncFromService();
        await this.refreshPhotoFrames();
        this.status.set('Frame settings saved.');
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  todayGallerySlug(): string {
    const prefix = this.draftGallery.sessionPrefix || 'session';
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${prefix}-${y}-${m}-${day}`;
  }

  /** Postcard canvas is always 14.8 × 10.0 cm; cells sit at exact cm inside it. */
  physicalSheetWidthCm(): number {
    return autoPhysicalSheetMm(
      this.draftPhysicalFrame.cellWidthCm,
      this.draftPhysicalFrame.cellHeightCm,
    ).pageWmm / 10;
  }

  physicalSheetHeightCm(): number {
    return autoPhysicalSheetMm(
      this.draftPhysicalFrame.cellWidthCm,
      this.draftPhysicalFrame.cellHeightCm,
    ).pageHmm / 10;
  }

  physicalSheetPixelW(): number {
    const pf = this.draftPhysicalFrame;
    const dpi = pf.dpi || 300;
    return Math.round((this.physicalSheetWidthCm() / 2.54) * dpi);
  }

  physicalSheetPixelH(): number {
    const pf = this.draftPhysicalFrame;
    const dpi = pf.dpi || 300;
    return Math.round((this.physicalSheetHeightCm() / 2.54) * dpi);
  }

  todayGalleryUrl(): string {
    const base = (this.draftGallery.apiBaseUrl || '').replace(/\/$/, '');
    return base ? `${base}/${this.todayGallerySlug()}` : '';
  }

  momentsWallUrl(): string {
    const base = (this.draftGallery.apiBaseUrl || '').replace(/\/$/, '');
    return base ? `${base}/wall` : '';
  }

  async saveGallery(): Promise<void> {
    this.status.set(null);
    this.busy.set(true);
    try {
      this.draftGallery.uploadOriginal = false;
      this.draftGallery.uploadFramed = false;
      this.draftGallery.uploadPhysical = false;
      const ok = await this.booth.save({
        gallery: { ...this.draftGallery },
      });
      if (ok) {
        this.syncFromService();
        this.status.set('Gallery settings saved.');
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async refreshUploadQueueSummary(): Promise<void> {
    if (!window.pbApi?.galleryGetUploadQueueSummary) {
      this.uploadQueueSummary.set(null);
      return;
    }
    try {
      const r = await window.pbApi.galleryGetUploadQueueSummary();
      this.uploadQueueSummary.set(r.ok && r.summary ? r.summary : null);
    } catch {
      this.uploadQueueSummary.set(null);
    }
  }

  async resyncUploadQueue(): Promise<void> {
    if (!window.pbApi?.galleryResyncUploadQueue) {
      this.status.set('Re-sync requires Electron.');
      return;
    }
    if (!this.draftGallery.enabled) {
      this.status.set('Enable gallery upload first.');
      return;
    }
    const base = (this.draftGallery.apiBaseUrl || '').replace(/\/$/, '');
    const token = this.draftGallery.uploadToken || '';
    if (!base || !token) {
      this.status.set('Set Gallery API URL and upload token first.');
      return;
    }
    this.busy.set(true);
    this.status.set('Re-syncing upload queue…');
    try {
      const r = await window.pbApi.galleryResyncUploadQueue({
        apiBaseUrl: base,
        uploadToken: token,
        eventPrefix: this.draftGallery.sessionPrefix,
        includeOk: this.galleryForceResync,
      });
      if (!r.ok) {
        this.status.set(r.error ?? 'Re-sync failed.');
        return;
      }
      const parts = [
        r.uploaded ? `${r.uploaded} uploaded` : null,
        r.requeued ? `${r.requeued} re-queued` : null,
        r.discovered ? `${r.discovered} discovered in capture/` : null,
        r.failed ? `${r.failed} failed` : null,
        r.pending ? `${r.pending} still pending` : null,
      ].filter(Boolean);
      this.status.set(parts.length ? `Re-sync done: ${parts.join(', ')}.` : 'Re-sync done — queue is up to date.');
      if (r.skippedMissing) {
        this.status.update((s) => `${s ?? ''} ${r.skippedMissing} missing local file(s).`.trim());
      }
      await this.refreshUploadQueueSummary();
    } catch (e) {
      this.status.set(String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async refreshPrinters(): Promise<void> {
    if (!window.pbApi?.listPrinters) {
      this.printers.set([]);
      this.status.set('Printer list requires Electron (packaged or electron:dev).');
      return;
    }
    const r = await window.pbApi.listPrinters({
      allowWifi: !!this.draftPrint.allowWifiPrinters,
    });
    if (!r.ok || !r.printers) {
      this.printers.set([]);
      if (r.error) this.status.set(r.error);
      return;
    }
    this.printers.set(
      r.printers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: !!p.isDefault,
        driverName: p.driverName || '',
        portName: p.portName || '',
        isIppClass: !!p.isIppClass,
        usesIppDriver: !!p.usesIppDriver,
        isCanonDriver: !!p.isCanonDriver,
        isDnpDriver: !!(p as { isDnpDriver?: boolean }).isDnpDriver || /dnp|ds-?rx1|\brx1\b/i.test(p.name),
        isUsb: p.isUsb !== false,
        isNetwork: !!p.isNetwork || !!p.isIppClass,
      })),
    );
    if (
      this.draftPrint.printerName &&
      !r.printers.some((p) => p.name === this.draftPrint.printerName)
    ) {
      this.draftPrint.printerName = null;
      this.status.set(
        `Saved printer was not a USB${this.draftPrint.allowWifiPrinters ? ' or Wi‑Fi' : ''} queue (or is offline). Switched to Auto.`,
      );
    } else if (!r.printers.length) {
      this.status.set(
        this.draftPrint.allowWifiPrinters
          ? 'No printers found. Connect USB or add a Wi‑Fi queue, then Refresh.'
          : 'No USB printers found. Connect a photo printer by USB, then Refresh.',
      );
    } else {
      this.status.set(
        `${r.printers.length} USB printer${r.printers.length === 1 ? '' : 's'} available.`,
      );
    }
  }

  printerLabel(p: PrinterOption): string {
    const tags: string[] = [];
    if (p.isDefault) tags.push('Windows default');
    if (p.isUsb) {
      if (p.usesIppDriver) tags.push('USB IPP fallback');
      else if (p.isDnpDriver) tags.push('DNP USB');
      else if (p.isCanonDriver) tags.push('Canon USB');
      else tags.push('USB');
    } else {
      tags.push('Wi‑Fi');
      if (p.isDnpDriver) tags.push('DNP');
      else if (p.isCanonDriver) tags.push('Canon');
    }
    if (p.portName) tags.push(p.portName);
    const tag = tags.length ? ` [${tags.join(', ')}]` : '';
    return `${p.displayName}${tag}`;
  }

  selectedPrinter(): PrinterOption | null {
    const name = this.draftPrint.printerName;
    if (!name) return null;
    return this.printers().find((p) => p.name === name) ?? null;
  }

  onAllowWifiChange(): void {
    void this.refreshPrinters();
  }

  async savePrint(): Promise<void> {
    this.status.set(null);
    this.busy.set(true);
    try {
      const ok = await this.booth.save({
        print: {
          enabled: !!this.draftPrint.enabled,
          autoPrint: !!this.draftPrint.autoPrint,
          printerName: this.draftPrint.printerName?.trim() || null,
          bleedScale: this.draftPrint.bleedScale ?? 1.06,
          framedEdgeInsetMm: this.draftPrint.framedEdgeInsetMm ?? 4,
          framedBottomExtraMm: this.draftPrint.framedBottomExtraMm ?? 2.5,
          allowWifiPrinters: !!this.draftPrint.allowWifiPrinters,
          stampTime: this.draftPrint.stampTime !== false,
        },
      });
      if (ok) {
        this.syncFromService();
        this.status.set(
          this.draftPrint.enabled
            ? this.draftPrint.printerName
              ? `Print enabled → ${this.draftPrint.printerName}${this.selectedPrinter()?.isUsb === false ? ' (Wi‑Fi).' : ' (USB).'}`
              : this.draftPrint.allowWifiPrinters
                ? 'Print enabled → Auto (USB first, then Wi‑Fi).'
                : 'Print enabled → Auto USB photo printer.'
            : 'Print settings saved (printing disabled).',
        );
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async testPrint(): Promise<void> {
    if (!window.pbApi?.printTest) {
      this.status.set('Test print requires Electron.');
      return;
    }
    this.busy.set(true);
    this.status.set('Sending test print…');
    try {
      // Persist current draft first so Auto / selected queue matches what we test.
      await this.booth.save({
        print: {
          enabled: true,
          autoPrint: !!this.draftPrint.autoPrint,
          printerName: this.draftPrint.printerName?.trim() || null,
          bleedScale: this.draftPrint.bleedScale ?? 1.06,
          framedEdgeInsetMm: this.draftPrint.framedEdgeInsetMm ?? 4,
          framedBottomExtraMm: this.draftPrint.framedBottomExtraMm ?? 2.5,
          allowWifiPrinters: !!this.draftPrint.allowWifiPrinters,
          stampTime: this.draftPrint.stampTime !== false,
        },
      });
      this.draftPrint.enabled = true;
      this.syncFromService();
      const r = await window.pbApi.printTest();
      if (r.ok) {
        this.printTroubleErr.set(null);
        this.status.set(
          `Test print sent${r.deviceName ? ` → ${r.deviceName}` : ''}${r.paper ? ` (${r.paper})` : ''}.`,
        );
      } else {
        const err = r.error || 'Test print failed.';
        this.printTroubleErr.set(err);
        this.status.set(err);
      }
    } catch (e) {
      const err = String(e);
      this.printTroubleErr.set(err);
      this.status.set(err);
    } finally {
      this.busy.set(false);
    }
  }

  async uploadPhotoFrame(): Promise<void> {
    if (!window.pbApi?.adminPickPhotoFrameImage || !window.pbApi.adminInstallPhotoFrame) {
      this.status.set('Frame upload requires Electron.');
      return;
    }
    const pick = await window.pbApi.adminPickPhotoFrameImage();
    if (!pick.ok || pick.canceled || !pick.path) return;
    this.busy.set(true);
    try {
      const inst = await window.pbApi.adminInstallPhotoFrame(pick.path);
      if (inst.ok && inst.filename) {
        // New uploads are guest-enabled by default
        if (this.draftGuestFrameFiles.length && !this.draftGuestFrameFiles.includes('__none__')) {
          this.draftGuestFrameFiles = [...this.draftGuestFrameFiles, inst.filename];
        } else if (this.draftGuestFrameFiles.includes('__none__')) {
          this.draftGuestFrameFiles = [inst.filename];
        }
        if (!this.draftDefaultFrameFile) {
          this.draftDefaultFrameFile = inst.filename;
        }
        await this.refreshPhotoFrames();
        const published = await this.publishFrameQuiet(inst.filename);
        const ratioNote =
          inst.width && inst.height
            ? inst.fitsGallery
              ? ` ${inst.width}×${inst.height} (3:2 — fills gallery).`
              : ` ${inst.width}×${inst.height} — gallery needs 3:2 (6×4, e.g. 1800×1200) to fill without a gap.`
            : '';
        this.status.set(
          published
            ? `Uploaded and published ${inst.filename} to Moments.${ratioNote}`
            : `Uploaded frame ${inst.filename}.${ratioNote} Save frame settings to apply guest list.`,
        );
      } else {
        this.status.set(inst.error ?? 'Upload failed.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async deletePhotoFrame(filename: string): Promise<void> {
    if (!window.pbApi?.adminDeletePhotoFrame) {
      this.status.set('Frame removal requires Electron.');
      return;
    }
    if (!confirm(`Remove frame "${filename}" from this machine?`)) return;
    this.busy.set(true);
    try {
      const r = await window.pbApi.adminDeletePhotoFrame(filename);
      if (r.ok) {
        this.draftGuestFrameFiles = this.draftGuestFrameFiles.filter((f) => f !== filename);
        if (this.draftDefaultFrameFile === filename) {
          this.draftDefaultFrameFile = null;
        }
        const creds = this.momentsGalleryCreds();
        if (creds?.uploadToken && window.pbApi.galleryDeleteRemoteFrame) {
          await window.pbApi.galleryDeleteRemoteFrame({
            apiBaseUrl: creds.apiBaseUrl,
            uploadToken: creds.uploadToken,
            filename,
          });
        }
        await this.refreshPhotoFrames();
        this.status.set(`Removed ${filename}.`);
      } else {
        this.status.set(r.error ?? 'Could not remove frame.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  private momentsGalleryCreds(): { apiBaseUrl: string; uploadToken: string } | null {
    const g = this.draftGallery?.apiBaseUrl
      ? this.draftGallery
      : this.booth.gallery();
    const apiBaseUrl = (g.apiBaseUrl || '').replace(/\/$/, '');
    const uploadToken = g.uploadToken || '';
    if (!apiBaseUrl) return null;
    return { apiBaseUrl, uploadToken };
  }

  private async publishFrameQuiet(filename: string): Promise<boolean> {
    const creds = this.momentsGalleryCreds();
    if (!creds?.uploadToken || !window.pbApi?.galleryPublishFrame) return false;
    const r = await window.pbApi.galleryPublishFrame({
      apiBaseUrl: creds.apiBaseUrl,
      uploadToken: creds.uploadToken,
      filename,
    });
    return !!r.ok;
  }

  /** Pull Moments frames; drop local overlays that were removed on the server. */
  private async mirrorFramesWithMoments(quiet = false): Promise<boolean> {
    const creds = this.momentsGalleryCreds();
    if (!creds || !window.pbApi?.gallerySyncFrames) return false;
    const r = await window.pbApi.gallerySyncFrames({
      apiBaseUrl: creds.apiBaseUrl,
      uploadToken: creds.uploadToken || undefined,
      pushLocal: !!creds.uploadToken,
      pruneLocal: true,
      timeoutMs: 20000,
    });
    if (!quiet) {
      if (r.ok) {
        const pruned = r.prunedCount ?? r.pruned?.length ?? 0;
        const published = r.publishedCount ?? r.published?.length ?? 0;
        const failHint =
          r.failed?.length && r.failed[0]
            ? ` — ${r.failed[0].filename}: ${r.failed[0].error || 'failed'}`
            : '';
        this.status.set(
          `Synced with Moments: pulled ${r.count ?? 0}, published ${published}, already current ${r.skippedCount ?? 0}, removed ${pruned} local` +
            (r.failed?.length ? ` (${r.failed.length} failed${failHint})` : '') +
            '.',
        );
      } else if (r.offline) {
        this.status.set('Moments unreachable — keeping local frames. Booth stays online.');
      } else {
        this.status.set(r.error ?? 'Sync failed.');
      }
    }
    return !!r.ok;
  }

  async refreshPhotoFramesAndSync(): Promise<void> {
    await this.mirrorFramesWithMoments(true);
    await this.refreshPhotoFrames();
  }

  async syncFramesFromMoments(): Promise<void> {
    const creds = this.momentsGalleryCreds();
    if (!creds || !window.pbApi?.gallerySyncFrames) {
      this.status.set('Set Gallery API base URL in Admin → Gallery first.');
      return;
    }
    this.busy.set(true);
    try {
      await this.mirrorFramesWithMoments(false);
      await this.refreshPhotoFrames();
    } finally {
      this.busy.set(false);
    }
  }

  async publishFrameToMoments(filename: string): Promise<void> {
    const creds = this.momentsGalleryCreds();
    if (!creds?.uploadToken || !window.pbApi?.galleryPublishFrame) {
      this.status.set('Set Gallery API URL + upload token in Admin → Gallery first.');
      return;
    }
    this.busy.set(true);
    try {
      const r = await window.pbApi.galleryPublishFrame({
        apiBaseUrl: creds.apiBaseUrl,
        uploadToken: creds.uploadToken,
        filename,
      });
      this.status.set(r.ok ? `Published ${filename} to Moments.` : r.error ?? 'Publish failed.');
    } finally {
      this.busy.set(false);
    }
  }

  async deleteRemoteFrame(filename: string): Promise<void> {
    const creds = this.momentsGalleryCreds();
    if (!creds?.uploadToken || !window.pbApi?.galleryDeleteRemoteFrame) {
      this.status.set('Set Gallery API URL + upload token in Admin → Gallery first.');
      return;
    }
    if (!confirm(`Delete "${filename}" from Moments and this machine?`)) return;
    this.busy.set(true);
    try {
      const r = await window.pbApi.galleryDeleteRemoteFrame({
        apiBaseUrl: creds.apiBaseUrl,
        uploadToken: creds.uploadToken,
        filename,
      });
      if (r.ok && window.pbApi.adminDeletePhotoFrame) {
        await window.pbApi.adminDeletePhotoFrame(filename);
        this.draftGuestFrameFiles = this.draftGuestFrameFiles.filter((f) => f !== filename);
        if (this.draftDefaultFrameFile === filename) {
          this.draftDefaultFrameFile = null;
        }
        await this.refreshPhotoFrames();
      }
      this.status.set(r.ok ? `Deleted ${filename} on Moments and locally.` : r.error ?? 'Remote delete failed.');
    } finally {
      this.busy.set(false);
    }
  }

  async refreshCameraDevices(): Promise<void> {
    const paths = await this.camera.getPaths();
    this.hasBridge.set(!!paths?.hasBridge);
    this.logFilePath.set(paths?.logFile ?? null);
    await this.boothLog.info('admin', 'refreshCameraDevices', {
      hasBridge: !!paths?.hasBridge,
      logFile: paths?.logFile,
    });

    if (paths?.hasBridge && this.draftCamera.source !== 'webcam') {
      const list = await this.camera.listSdkCameras();
      if (list.ok) {
        this.sdkCameras.set(list.cameras);
        if (list.cameras.length > 0 && this.draftCamera.sdkCameraIndex >= list.cameras.length) {
          this.draftCamera = { ...this.draftCamera, sdkCameraIndex: 0 };
        }
      } else {
        this.sdkCameras.set([]);
        if (list.error && this.draftCamera.source === 'sdk') {
          this.status.set(`Canon SDK: ${list.error}`);
        } else if (list.error && this.draftCamera.source === 'auto') {
          this.status.set(`Using system camera fallback (${list.error}).`);
        }
      }
    } else {
      this.sdkCameras.set([]);
    }

    await this.refreshWebcamDevices();
  }

  private async refreshWebcamDevices(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      this.webcamDevices.set([]);
      return;
    }
    try {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch {
        /* labels may be empty without permission */
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label?.trim() || `Camera ${i + 1}`,
        }));
      this.webcamDevices.set(cams);
      if (
        this.draftCamera.webcamDeviceId &&
        !cams.some((c) => c.deviceId === this.draftCamera.webcamDeviceId)
      ) {
        this.draftCamera = { ...this.draftCamera, webcamDeviceId: null };
      }
      stream?.getTracks().forEach((t) => t.stop());
    } catch (e) {
      this.webcamDevices.set([]);
      this.status.set(`Webcam list failed: ${String(e)}`);
    }
  }

  async openLogsFolder(): Promise<void> {
    const r = await this.boothLog.openLogsFolder();
    if (r.ok) {
      this.status.set(`Opened logs folder: ${r.path}`);
    } else {
      this.status.set(
        `Could not open folder. Check logs\\photobooth.log next to the app. (${r.error ?? ''})`,
      );
    }
  }

  async saveDebug(): Promise<void> {
    this.status.set(null);
    this.busy.set(true);
    try {
      const ok = await this.booth.save({
        debug: { ...this.draftDebug },
      });
      if (ok) {
        this.syncFromService();
        this.status.set(
          this.draftDebug.enabled || this.draftDebug.showPreviewAfterGenerate
            ? 'Debug settings saved.'
            : 'Debug settings saved (logging and preview off).',
        );
        if (this.draftDebug.enabled) {
          await this.refreshDebugPanel();
          await this.boothLog.info('admin', 'debug panel enabled');
        }
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async refreshDebugPanel(): Promise<void> {
    const p = await this.boothLog.refreshLogPath();
    this.logFilePath.set(p);
    await this.boothLog.loadTailFromDisk(300);
  }

  clearDebugPanel(): void {
    this.boothLog.clear();
    this.status.set('Cleared on-screen log buffer (file on disk kept).');
  }

  async pingDebugLog(): Promise<void> {
    await this.boothLog.info('admin', 'debug ping', {
      at: new Date().toISOString(),
      galleryEnabled: this.draftGallery.enabled,
    });
    this.status.set('Wrote a test log line.');
  }

  async saveCamera(): Promise<void> {
    this.status.set(null);
    this.busy.set(true);
    try {
      const sdkIndex = Math.max(0, Math.floor(this.draftCamera.sdkCameraIndex ?? 0));
      const ok = await this.booth.save({
        camera: {
          source: this.draftCamera.source,
          sdkCameraIndex: sdkIndex,
          webcamDeviceId: this.draftCamera.webcamDeviceId || null,
        },
      });
      if (ok) {
        this.syncFromService();
        this.status.set('Camera settings saved. New sessions use this device on next capture.');
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async testOpenAiKey(): Promise<void> {
    if (!window.pbApi?.adminTestOpenAiKey) {
      this.status.set('API key test requires Electron.');
      return;
    }
    this.status.set(null);
    this.busy.set(true);
    try {
      const draft = this.openAiKeyDraft.trim();
      const r = await window.pbApi.adminTestOpenAiKey(draft || undefined);
      if (r.ok) {
        this.status.set(r.message ?? 'API key is valid.');
      } else {
        this.status.set(r.error ?? 'API key test failed.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  addAiMode(): void {
    const id = `mode_${Date.now()}`;
    this.draftAiModes = [
      ...this.draftAiModes,
      { id, label: 'New mode', prompt: '', useInpainting: false, randomizeBackground: true },
    ];
  }

  addDjMode(): void {
    if (this.draftAiModes.some((m) => m.id === 'dj')) {
      this.status.set('DJ mode already exists.');
      return;
    }
    this.draftAiModes = [
      {
        id: 'dj',
        label: 'DJ',
        prompt: DJ_PROMPT_ONLY,
        useInpainting: true,
        randomizeBackground: true,
        inpaintPrompt: DJ_INPAINT_PROMPT,
      },
      ...this.draftAiModes,
    ];
    this.draftDefaultAiModeId = 'dj';
    this.draftAiEnabled = true;
  }

  removeAiMode(index: number): void {
    this.draftAiModes = this.draftAiModes.filter((_, i) => i !== index);
  }

  /** Paste the built-in Newspaper prompt into a row (same text as default config). */
  applyNewspaperPrompt(index: number): void {
    const next = [...this.draftAiModes];
    const row = next[index];
    if (!row) return;
    next[index] = { ...row, prompt: NEWSPAPER_AI_PROMPT };
    this.draftAiModes = next;
  }

  applyDjInpaintPrompt(index: number): void {
    const next = [...this.draftAiModes];
    const row = next[index];
    if (!row) return;
    next[index] = {
      ...row,
      useInpainting: true,
      randomizeBackground: true,
      inpaintPrompt: DJ_INPAINT_PROMPT,
    };
    this.draftAiModes = next;
  }

  async refreshAiBackgrounds(modeId: string): Promise<void> {
    if (!window.pbApi?.adminListAiBackgrounds || !modeId.trim()) return;
    const r = await window.pbApi.adminListAiBackgrounds(modeId.trim());
    if (r.ok && r.backgrounds) {
      this.aiBackgrounds.update((prev) => ({ ...prev, [modeId.trim()]: r.backgrounds! }));
    }
  }

  async refreshAllAiBackgrounds(): Promise<void> {
    for (const m of this.draftAiModes) {
      if (m.useInpainting) {
        await this.refreshAiBackgrounds(m.id);
      }
    }
  }

  backgroundsForMode(modeId: string): AiBackgroundItem[] {
    return this.aiBackgrounds()[modeId] ?? [];
  }

  async uploadAiBackground(modeId: string): Promise<void> {
    if (!window.pbApi?.adminPickAiBackgroundImage || !window.pbApi.adminInstallAiBackground) {
      this.status.set('Background upload requires Electron.');
      return;
    }
    const pick = await window.pbApi.adminPickAiBackgroundImage();
    if (!pick.ok || pick.canceled || !pick.path) return;
    this.busy.set(true);
    try {
      const inst = await window.pbApi.adminInstallAiBackground(modeId, pick.path);
      if (inst.ok) {
        await this.refreshAiBackgrounds(modeId);
        this.status.set(`Background uploaded for ${modeId}.`);
      } else {
        this.status.set(inst.error ?? 'Upload failed.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async deleteAiBackground(modeId: string, filename: string): Promise<void> {
    if (!window.pbApi?.adminDeleteAiBackground) {
      this.status.set('Background removal requires Electron.');
      return;
    }
    if (!confirm(`Remove background "${filename}" from mode ${modeId}?`)) return;
    this.busy.set(true);
    try {
      const r = await window.pbApi.adminDeleteAiBackground(modeId, filename);
      if (r.ok) {
        await this.refreshAiBackgrounds(modeId);
        this.status.set(`Removed ${filename}.`);
      } else {
        this.status.set(r.error ?? 'Could not remove background.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async saveAi(): Promise<void> {
    this.status.set(null);
    const normalized = this.draftAiModes
      .map((m) => ({
        id: m.id.trim(),
        label: m.label.trim(),
        prompt: m.prompt.trim(),
        useInpainting: m.useInpainting === true,
        randomizeBackground: m.randomizeBackground !== false,
        inpaintPrompt: m.inpaintPrompt?.trim() || undefined,
      }))
      .filter((m) => m.id.length > 0 && m.label.length > 0 && m.prompt.length > 0);
    if (normalized.length === 0) {
      this.status.set('Add at least one mode with id, label, and prompt.');
      return;
    }
    let defaultId: string | null = this.draftDefaultAiModeId;
    if (defaultId === PLAIN_PHOTO_MODE_ID) {
      // plain-only default is valid
    } else if (defaultId && !normalized.some((m) => m.id === defaultId)) {
      this.status.set('Default mode must match a mode id below, or choose Guest chooses.');
      return;
    }
    let aiEnabled = this.draftAiEnabled;
    if (defaultId && defaultId !== PLAIN_PHOTO_MODE_ID && !aiEnabled) {
      aiEnabled = true;
    }
    const inpaintModes = normalized.filter((m) => m.useInpainting);
    this.busy.set(true);
    try {
      const payload: Record<string, unknown> = {
        aiGenerationEnabled: aiEnabled,
        requireQrUnlock: this.draftRequireQrUnlock,
        defaultAiModeId: defaultId,
        aiModes: normalized.map(({ inpaintPrompt, useInpainting, randomizeBackground, ...rest }) => ({
          ...rest,
          ...(useInpainting
            ? {
                useInpainting: true,
                randomizeBackground,
                ...(inpaintPrompt ? { inpaintPrompt } : {}),
              }
            : {}),
        })),
      };
      if (this.openAiKeyDraft.trim()) {
        payload['openAiApiKey'] = this.openAiKeyDraft.trim();
      }
      const ok = await this.booth.save(payload);
      if (ok) {
        this.openAiKeyDraft = '';
        this.draftAiEnabled = aiEnabled;
        await this.refreshAllAiBackgrounds();
        const missingBg = inpaintModes.filter((m) => this.backgroundsForMode(m.id).length === 0);
        if (missingBg.length) {
          this.status.set(
            `AI settings saved. Upload backgrounds for: ${missingBg.map((m) => m.id).join(', ')}.`,
          );
        } else {
          this.status.set('AI settings saved.');
        }
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async clearOpenAiKey(): Promise<void> {
    this.status.set(null);
    this.busy.set(true);
    try {
      const ok = await this.booth.save({ openAiApiKey: '' });
      if (ok) {
        await this.booth.load();
        this.syncFromService();
        this.status.set('OpenAI API key removed from this machine.');
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async refreshThemes(): Promise<void> {
    if (!window.pbApi?.adminListThemes) {
      return;
    }
    const r = await window.pbApi.adminListThemes();
    if (r.ok && r.themes) {
      this.themes.set(r.themes as ThemeListItem[]);
    }
  }

  async saveCopy(): Promise<void> {
    this.status.set(null);
    this.busy.set(true);
    try {
      const ok = await this.booth.save({ copy: this.draft, capture: this.draftCapture });
      this.status.set(ok ? 'Capture settings saved.' : 'Save failed (run in Electron).');
    } finally {
      this.busy.set(false);
    }
  }

  async saveThemeSelection(): Promise<void> {
    this.status.set(null);
    this.busy.set(true);
    try {
      const ok = await this.booth.save({ activeThemeId: this.activeThemeId });
      if (ok) {
        await this.theme.applyFromConfig();
        this.status.set('Theme updated.');
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async installZip(): Promise<void> {
    if (!window.pbApi?.adminPickThemeZip || !window.pbApi.adminInstallThemeFromZip) {
      this.status.set('Theme upload requires Electron.');
      return;
    }
    this.status.set(null);
    const pick = await window.pbApi.adminPickThemeZip();
    if (!pick.ok || pick.canceled || !pick.path) {
      return;
    }
    this.busy.set(true);
    try {
      const inst = await window.pbApi.adminInstallThemeFromZip(pick.path);
      if (inst.ok && inst.id) {
        this.activeThemeId = inst.id;
        await this.booth.save({ activeThemeId: inst.id });
        await this.booth.load();
        await this.theme.applyFromConfig();
        await this.refreshThemes();
        this.status.set(`Installed theme “${inst.id}”.`);
      } else {
        this.status.set(inst.error ?? 'Install failed.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async exportTemplate(): Promise<void> {
    this.status.set(null);
    if (!window.pbApi?.adminExportThemeTemplate) {
      this.status.set('Export requires Electron.');
      return;
    }
    const r = await window.pbApi.adminExportThemeTemplate();
    if (r.ok && r.path) {
      this.status.set(`Saved zip to: ${r.path}`);
    } else {
      this.status.set(r.error ?? 'Export failed.');
    }
  }

  async downloadSelectedTheme(): Promise<void> {
    this.status.set(null);
    if (!window.pbApi?.adminExportThemeZip) {
      this.status.set('Theme download requires Electron.');
      return;
    }
    this.busy.set(true);
    try {
      const r = await window.pbApi.adminExportThemeZip(this.activeThemeId);
      if (r.ok && r.path) {
        this.status.set(`Saved theme zip to: ${r.path}`);
      } else {
        this.status.set(r.error ?? 'Export failed.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async removeSelectedTheme(): Promise<void> {
    if (this.activeThemeId === 'default') {
      return;
    }
    if (
      !confirm(
        `Remove theme "${this.activeThemeId}" from this machine? This deletes the theme folder. Continue?`,
      )
    ) {
      return;
    }
    if (!window.pbApi?.adminDeleteTheme) {
      this.status.set('Removing themes requires Electron.');
      return;
    }
    this.status.set(null);
    this.busy.set(true);
    try {
      const r = await window.pbApi.adminDeleteTheme(this.activeThemeId);
      if (r.ok) {
        await this.booth.load();
        this.syncFromService();
        await this.theme.applyFromConfig();
        await this.refreshThemes();
        const extra = r.switchedActiveToDefault ? ' Switched active theme to default.' : '';
        this.status.set(`Theme “${r.removedId ?? this.activeThemeId}” removed.${extra}`);
      } else {
        this.status.set(r.error ?? 'Could not remove theme.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async saveBranding(): Promise<void> {
    this.status.set(null);
    this.busy.set(true);
    try {
      const ok = await this.booth.save({
        branding: {
          brandName: this.draftBranding.brandName?.trim() || null,
          applyBrandToAi: this.draftBranding.applyBrandToAi,
        },
      });
      if (ok) {
        this.syncFromService();
        await this.branding.refreshAll();
        this.status.set('Brand settings saved.');
      } else {
        this.status.set('Save failed (run in Electron).');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async uploadLogo(): Promise<void> {
    if (!window.pbApi?.adminPickLogoImage || !window.pbApi.adminInstallLogo) {
      this.status.set('Logo upload requires Electron.');
      return;
    }
    this.status.set(null);
    const pick = await window.pbApi.adminPickLogoImage();
    if (!pick.ok || pick.canceled || !pick.path) {
      return;
    }
    this.busy.set(true);
    try {
      const inst = await window.pbApi.adminInstallLogo(pick.path);
      if (inst.ok && inst.logoFile) {
        await this.booth.load();
        await this.branding.refresh();
        this.status.set(`App logo saved (${inst.logoFile}).`);
      } else {
        this.status.set(inst.error ?? 'Could not save logo.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async removeLogo(): Promise<void> {
    if (!window.pbApi?.adminClearLogo) {
      this.status.set('Logo removal requires Electron.');
      return;
    }
    this.busy.set(true);
    try {
      const r = await window.pbApi.adminClearLogo();
      if (r.ok) {
        await this.booth.load();
        await this.branding.refresh();
        this.status.set('App logo removed; emoji icons restored.');
      } else {
        this.status.set(r.error ?? 'Could not remove logo.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async uploadAiLogo(): Promise<void> {
    if (!window.pbApi?.adminPickAiLogoImage || !window.pbApi.adminInstallAiLogo) {
      this.status.set('AI logo upload requires Electron.');
      return;
    }
    this.status.set(null);
    const pick = await window.pbApi.adminPickAiLogoImage();
    if (!pick.ok || pick.canceled || !pick.path) {
      return;
    }
    this.busy.set(true);
    try {
      const inst = await window.pbApi.adminInstallAiLogo(pick.path);
      if (inst.ok && inst.aiLogoFile) {
        await this.booth.load();
        await this.branding.refreshAiLogo();
        this.status.set(`AI reference logo saved (${inst.aiLogoFile}).`);
      } else {
        this.status.set(inst.error ?? 'Could not save AI logo.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async removeAiLogo(): Promise<void> {
    if (!window.pbApi?.adminClearAiLogo) {
      this.status.set('AI logo removal requires Electron.');
      return;
    }
    this.busy.set(true);
    try {
      const r = await window.pbApi.adminClearAiLogo();
      if (r.ok) {
        await this.booth.load();
        await this.branding.refreshAiLogo();
        this.status.set('AI reference logo removed.');
      } else {
        this.status.set(r.error ?? 'Could not remove AI logo.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async reloadConfig(): Promise<void> {
    await this.booth.load();
    this.syncFromService();
    await this.theme.applyFromConfig();
    await this.branding.refreshAll();
    this.status.set('Reloaded from disk.');
  }

  logout(): void {
    setAdminSession(false);
    void this.router.navigate(['/admin/login']);
  }

  async toggleAutoPrint(on: boolean): Promise<void> {
    this.draftPrint.autoPrint = on;
    await this.savePrint();
    await this.kickJobs();
  }

  async refreshJobs(): Promise<void> {
    const r = await window.pbApi?.jobsList?.();
    if (r?.ok) {
      const jobs = ((r.jobs as unknown as BoothJobItem[]) || []).slice();
      this.jobItems.set(jobs);
      this.jobSummary.set((r.summary as Record<string, number>) || null);
      void this.loadJobThumbs(jobs);
    }
  }

  private async loadJobThumbs(jobs: BoothJobItem[]): Promise<void> {
    if (!window.pbApi?.readFileThumbBase64) return;
    const map = { ...this.jobThumbUrls() };
    const need = jobs.filter((j) => j.aiPath && !map[j.id]).slice(0, 40);
    for (const j of need) {
      try {
        map[j.id] = await window.pbApi.readFileThumbBase64!(j.aiPath!, 240);
      } catch {
        /* skip */
      }
    }
    this.jobThumbUrls.set(map);
  }

  formatJobWhen(iso?: string | null): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso);
    return new Date(t).toLocaleString();
  }

  formatAiElapsed(j: BoothJobItem): string {
    if (j.aiStatus !== 'running' || !j.aiStartedAt) return '';
    const start = Date.parse(j.aiStartedAt);
    if (!Number.isFinite(start)) return '';
    const sec = Math.max(0, Math.round((Date.now() - start) / 1000));
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }

  aiProgressPct(j: BoothJobItem): number {
    if (j.aiStatus === 'done') return 100;
    if (j.aiStatus !== 'running') return 0;
    const n = Number(j.aiProgress);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 8;
  }

  async kickJobs(): Promise<void> {
    await window.pbApi?.jobsKick?.();
    await this.refreshJobs();
  }

  async printOp(id: string, op: 'retry' | 'cancel' | 'skip' | 'top' | 'reprint'): Promise<void> {
    await window.pbApi?.jobsPrintOp?.({ id, op });
    await this.refreshJobs();
  }

  setPrintHistoryWhen(when: 'all' | 'today' | 'range'): void {
    this.printHistoryWhen.set(when);
    this.printHistoryPage.set(1);
  }

  goPrintHistoryPage(delta: number): void {
    const next = Math.min(
      this.printHistoryPageCount(),
      Math.max(1, this.printHistoryPage() + delta),
    );
    this.printHistoryPage.set(next);
  }

  async selectHistoryJob(job: BoothJobItem): Promise<void> {
    this.historyPreviewId.set(job.id);
    this.historyPreviewUrl.set(null);
    if (!job.aiPath || !window.pbApi?.readFileBase64) return;
    try {
      this.historyPreviewUrl.set(await window.pbApi.readFileBase64(job.aiPath));
    } catch {
      this.historyPreviewUrl.set(null);
    }
  }

  async togglePicked(id: string, picked: boolean): Promise<void> {
    await window.pbApi?.jobsSetDisplayPicked?.({ id, picked });
    await this.refreshJobs();
  }

  async saveCans(): Promise<void> {
    this.busy.set(true);
    try {
      const ok = await this.booth.save({
        cans: this.draftCans,
        aiModes: this.draftCans.map((c) => ({
          id: c.id,
          label: c.label,
          prompt: c.prompt,
          inpaintPrompt: c.inpaintPrompt,
          useInpainting: c.useInpainting !== false,
          randomizeBackground: false,
        })),
      });
      if (ok && window.pbApi?.adminSaveCompositionFace) {
        for (const c of this.draftCans) {
          await window.pbApi.adminSaveCompositionFace(c.id, this.faceBoxForCan(c));
        }
        await this.refreshCompositions();
      }
      this.status.set(ok ? 'Cans saved — each flavor keeps its own scene and face box.' : 'Could not save cans.');
    } finally {
      this.busy.set(false);
    }
  }

  compositionFor(canId: string): CanCompositionPreview | null {
    return this.compositions()[canId] ?? null;
  }

  faceBox(i: number): PhotoboothFaceBox {
    return this.faceBoxForCan(this.draftCans[i]);
  }

  faceBoxForCan(c: PhotoboothCan): PhotoboothFaceBox {
    if (!c.face) {
      c.face = { ...PHOTOBOOTH_DEFAULT_FACE };
    }
    return c.face;
  }

  async refreshCompositions(): Promise<void> {
    if (!window.pbApi?.adminListCompositions) return;
    const r = await window.pbApi.adminListCompositions();
    if (!r.ok || !r.items) return;
    const next: Record<string, CanCompositionPreview> = {};
    for (const item of r.items) {
      if (!item.canId) continue;
      const face = item.face
        ? { ...item.face }
        : { ...PHOTOBOOTH_DEFAULT_FACE };
      next[item.canId] = {
        url: item.url ?? null,
        source: item.source ?? null,
        filename: item.filename ?? null,
        face,
      };
      const can = this.draftCans.find((c) => c.id === item.canId);
      if (can) can.face = { ...face };
    }
    this.compositions.set(next);
  }

  async uploadCanScene(canId: string): Promise<void> {
    if (!window.pbApi?.adminPickCompositionImage || !window.pbApi.adminInstallComposition) {
      this.status.set('Scene upload requires Electron.');
      return;
    }
    const pick = await window.pbApi.adminPickCompositionImage();
    if (!pick.ok || pick.canceled || !pick.path) return;
    this.busy.set(true);
    try {
      const inst = await window.pbApi.adminInstallComposition(canId, pick.path);
      if (!inst.ok) {
        this.status.set(inst.error ?? 'Could not install scene.');
        return;
      }
      await this.refreshCompositions();
      this.status.set(`Installed unique scene for ${canId}. Adjust the face box if the driver head moved.`);
    } finally {
      this.busy.set(false);
    }
  }

  async saveDisplay(): Promise<void> {
    this.busy.set(true);
    try {
      const tags = this.displayTagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const ok = await this.booth.save({
        display: { ...this.draftDisplay, tags },
      });
      this.status.set(ok ? 'Display settings saved.' : 'Could not save display.');
    } finally {
      this.busy.set(false);
    }
  }

  async saveEmail(): Promise<void> {
    this.busy.set(true);
    try {
      const email: PhotoboothEmailConfig = {
        enabled: !!this.draftEmail.enabled,
        provider: 'sendgrid',
        apiUrl: (this.draftEmail.apiUrl || PHOTOBOOTH_DEFAULT_EMAIL.apiUrl).trim(),
        from: (this.draftEmail.from || '').trim(),
        fromName: (this.draftEmail.fromName || '').trim() || 'ZYN Photobooth',
        subject: this.draftEmail.subject || PHOTOBOOTH_DEFAULT_EMAIL.subject,
        body: this.draftEmail.body || PHOTOBOOTH_DEFAULT_EMAIL.body,
      };
      if (this.sendGridKeyDraft.trim()) {
        email.apiKey = this.sendGridKeyDraft.trim();
      }
      const ok = await this.booth.save({ email });
      if (ok) {
        this.sendGridKeyDraft = '';
        this.syncFromService();
      }
      this.status.set(ok ? 'SendGrid settings saved.' : 'Could not save email.');
    } finally {
      this.busy.set(false);
    }
  }

  async saveOpenAiApi(): Promise<void> {
    this.busy.set(true);
    try {
      const payload: Record<string, unknown> = {
        openAiApiUrl:
          (this.draftOpenAiApiUrl || PHOTOBOOTH_DEFAULT_OPENAI_API_URL).trim().replace(/\/$/, '') ||
          PHOTOBOOTH_DEFAULT_OPENAI_API_URL,
      };
      if (this.openAiKeyDraft.trim()) {
        payload['openAiApiKey'] = this.openAiKeyDraft.trim();
      }
      const ok = await this.booth.save(payload);
      if (ok) {
        this.openAiKeyDraft = '';
        this.syncFromService();
      }
      this.status.set(ok ? 'OpenAI API settings saved.' : 'Could not save OpenAI API.');
    } finally {
      this.busy.set(false);
    }
  }
}
