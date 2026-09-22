import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import QRCode from 'qrcode';
import { CameraService } from '../../services/camera.service';
import { BoothConfigService } from '../../services/booth-config.service';
import { AiStyleService } from '../../services/ai-style.service';
import { BoothModeService } from '../../services/booth-mode.service';
import { AiGallerySessionService } from '../../services/ai-gallery-session.service';
import { GalleryUploadService } from '../../services/gallery-upload.service';
import { PLAIN_PHOTO_MODE_ID } from '../../models/photobooth-config.model';

import { PrintTroubleDialogComponent } from '../../components/print-trouble-dialog/print-trouble-dialog.component';
import { PhysicalFrameAdjustDialogComponent } from '../../components/physical-frame-adjust-dialog/physical-frame-adjust-dialog.component';
import { PhysicalFrameLayoutService } from '../../services/physical-frame-layout.service';
import type { PhysicalPhotoCrop } from '../../models/physical-frame-layout';

@Component({
  selector: 'pb-result-page',
  imports: [PrintTroubleDialogComponent, PhysicalFrameAdjustDialogComponent],
  templateUrl: './result-page.component.html',
  styleUrl: './result-page.component.scss',
})
export class ResultPageComponent implements OnInit, OnDestroy {
  readonly booth = inject(BoothConfigService);
  private readonly aiStyle = inject(AiStyleService);
  private readonly boothMode = inject(BoothModeService);
  private readonly gallerySession = inject(AiGallerySessionService);
  readonly galleryUpload = inject(GalleryUploadService);
  private readonly physicalLayout = inject(PhysicalFrameLayoutService);
  readonly copy = this.booth.copy;

  /** Guest has not tapped Done yet — photo stays local so retakes never hit the gallery. */
  readonly isPreview = signal(false);

  readonly path = signal<string | null>(null);
  readonly imageDataUrl = signal<string | null>(null);
  readonly err = signal<string | null>(null);
  readonly resultAspectRatio = signal<number | null>(null);

  readonly aiGenerating = signal(false);
  readonly aiErr = signal<string | null>(null);
  readonly aiModelUsed = signal<string | null>(null);
  readonly thinkingStep = signal(0);
  readonly aiEtaSec = signal(22);
  readonly aiElapsedSec = signal(0);
  readonly aiEtaLabel = computed(() => this.formatDuration(this.aiEtaSec()));
  readonly aiElapsedLabel = computed(() => this.formatDuration(this.aiElapsedSec()));
  readonly aiOvertime = computed(() => this.aiEtaSec() <= 0);

  readonly shareOpen = signal(false);
  readonly shareQrDataUrl = signal<string | null>(null);
  readonly shareBusy = signal(false);

  readonly printBusy = signal(false);
  readonly printDone = signal(false);
  readonly printErr = signal<string | null>(null);

  readonly makePhysicalBusy = signal(false);
  readonly makePhysicalErr = signal<string | null>(null);
  readonly physicalAdjustOpen = signal(false);
  readonly makeFramedBusy = signal(false);
  /** Digital photo used for gallery share if the preview switches to a cut sheet. */
  readonly digitalPath = signal<string | null>(null);

  readonly viewingPhysicalSheet = computed(() => this.isPhysicalSheetPath(this.path()));
  readonly sharePath = computed(() => this.digitalPath() || this.path());
  readonly uploadRecord = computed(() => this.galleryUpload.recordFor(this.sharePath()));
  readonly canShare = computed(() => {
    if (this.boothMode.isPhysicalFrameMode()) return false;
    if (!this.galleryUpload.enabled()) return false;
    const r = this.uploadRecord();
    return r?.status === 'ok' && !!r.shareUrl;
  });
  readonly shareUploading = computed(() => {
    if (this.boothMode.isPhysicalFrameMode()) return false;
    if (!this.galleryUpload.enabled()) return false;
    const r = this.uploadRecord();
    return !r || r.status === 'pending' || r.status === 'queued';
  });
  readonly shareFailed = computed(() => {
    if (this.boothMode.isPhysicalFrameMode()) return false;
    if (!this.galleryUpload.enabled()) return false;
    const r = this.uploadRecord();
    return r?.status === 'error';
  });
  readonly showGalleryShare = computed(
    () =>
      !this.isPreview() &&
      this.galleryUpload.enabled() &&
      !this.boothMode.isPhysicalFrameMode(),
  );
  readonly showPrint = computed(() => !this.isPreview() && this.booth.print().enabled === true);
  readonly canPrint = computed(
    () => this.showPrint() && !!this.path() && !this.printBusy() && !this.printDone(),
  );
  readonly showMakePhysical = computed(
    () =>
      !this.isPreview() &&
      !!this.path() &&
      !this.aiGenerating() &&
      !this.boothMode.isPhysicalFrameMode(),
  );
  readonly viewingFramedPhoto = computed(() => !!this.path() && /_framed\.png$/i.test(this.path() || ''));
  readonly showMakeFramed = computed(
    () =>
      !this.isPreview() &&
      !!this.path() &&
      !this.aiGenerating() &&
      !this.boothMode.isPhysicalFrameMode() &&
      !this.viewingPhysicalSheet() &&
      this.booth.photoFrames().enabled,
  );
  readonly physicalAdjustSource = computed(() => {
    const p = this.path();
    return p ? this.originalCapturePath(p) : '';
  });
  readonly printUsesPhysicalLayout = computed(
    () => this.boothMode.isPhysicalFrameMode() || this.viewingPhysicalSheet(),
  );

  private aiTimer?: ReturnType<typeof setInterval>;
  private sharePoll?: ReturnType<typeof setInterval>;
  private navSub?: { unsubscribe(): void };

  readonly showAiSection = computed(() => {
    if (this.isPreview()) return false;
    if (!this.booth.aiGenerationEnabled()) return false;
    const id = this.aiStyle.selectedModeId();
    if (!id || id === PLAIN_PHOTO_MODE_ID) return false;
    return true;
  });

  readonly canRunAiGeneration = computed(
    () => this.showAiSection() && this.booth.openAiConfigured(),
  );

  readonly selectedMode = computed(() => {
    const id = this.aiStyle.selectedModeId();
    if (!id) return null;
    return this.booth.aiModes().find((m) => m.id === id) ?? null;
  });

  readonly usesInpainting = computed(() => this.selectedMode()?.useInpainting === true);

  constructor(
    private readonly router: Router,
    private readonly camera: CameraService,
  ) {
    const nav = this.router.getCurrentNavigation();
    const st = nav?.extras?.state as { path?: string; preview?: boolean } | undefined;
    if (st?.path) {
      this.path.set(st.path);
    }
    if (st?.preview === true) {
      this.isPreview.set(true);
    }
  }

  async ngOnInit(): Promise<void> {
    this.navSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => {
        if (this.router.url.includes('/result')) {
          void this.loadPhotoFromRoute();
        }
      });
    await this.loadPhotoFromRoute();
  }

  private async loadPhotoFromRoute(): Promise<void> {
    const nav = this.router.getCurrentNavigation();
    const fromNav = nav?.extras?.state as { path?: string; preview?: boolean } | undefined;
    const fromHistory = history.state as { path?: string; preview?: boolean } | undefined;
    const pp = fromNav?.path || fromHistory?.path || this.path();
    const preview = fromNav?.preview ?? fromHistory?.preview;
    if (preview === true) this.isPreview.set(true);
    else if (preview === false) this.isPreview.set(false);
    if (!pp) {
      this.err.set('No image path — go back and capture again.');
      this.imageDataUrl.set(null);
      return;
    }
    if (pp !== this.path()) {
      this.path.set(pp);
      this.imageDataUrl.set(null);
      this.resultAspectRatio.set(null);
      this.shareOpen.set(false);
      this.shareQrDataUrl.set(null);
      this.makePhysicalErr.set(null);
      this.printDone.set(false);
    }
    if (!this.isPhysicalSheetPath(pp)) {
      this.digitalPath.set(pp);
    } else if (!this.digitalPath()) {
      this.digitalPath.set(this.originalCapturePath(pp));
    }
    if (!window.pbApi?.readFileBase64) {
      this.err.set('Preview needs Electron.');
      return;
    }
    try {
      const url = await window.pbApi.readFileBase64(pp);
      if (this.path() !== pp) return;
      this.imageDataUrl.set(url);
      this.err.set(null);
    } catch (e) {
      this.err.set(String(e));
    }

    if (this.isPreview()) {
      this.stopSharePoll();
      return;
    }
    this.startShareUploadIfNeeded(pp);
  }

  private stopSharePoll(): void {
    if (this.sharePoll) {
      clearInterval(this.sharePoll);
      this.sharePoll = undefined;
    }
  }

  private startShareUploadIfNeeded(pp: string): void {
    this.stopSharePoll();
    if (this.isPreview()) return;
    if (!this.galleryUpload.enabled() || this.boothMode.isPhysicalFrameMode()) {
      return;
    }
    const sharePp = this.isPhysicalSheetPath(pp)
      ? this.digitalPath() || this.originalCapturePath(pp)
      : pp;
    void this.galleryUpload.ensureShareUpload(sharePp);
    let ticks = 0;
    this.sharePoll = setInterval(() => {
      ticks += 1;
      void this.galleryUpload.recordFor(this.sharePath());
      if (this.canShare() && this.sharePoll) {
        clearInterval(this.sharePoll);
        this.sharePoll = undefined;
        return;
      }
      if (ticks % 10 === 0) {
        void this.galleryUpload.ensureShareUpload(this.sharePath() || pp);
      }
      if (ticks >= 60 && this.shareUploading()) {
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (offline) {
          ticks = 0;
          void this.galleryUpload.flushQueue();
          return;
        }
        const cur = this.galleryUpload.recordFor(this.sharePath());
        if (!cur || cur.status === 'pending' || cur.status === 'queued') {
          this.galleryUpload.markUploadTimedOut(this.sharePath() || pp);
        }
        if (this.sharePoll) {
          clearInterval(this.sharePoll);
          this.sharePoll = undefined;
        }
      }
    }, 400);
  }

  async generateAi(): Promise<void> {
    if (!this.canRunAiGeneration()) {
      return;
    }
    const pp = this.path();
    const mode = this.selectedMode();
    if (!pp || !mode || !window.pbApi?.openAiGenerateImage) {
      return;
    }
    const source = this.isPhysicalSheetPath(pp) ? this.originalCapturePath(pp) : pp;
    this.aiGenerating.set(true);
    this.aiErr.set(null);
    this.aiModelUsed.set(null);
    this.thinkingStep.set(0);
    this.startAiCountdown(this.usesInpainting() ? 28 : 22);
    try {
      await new Promise<void>((r) => setTimeout(r, 220));
      this.thinkingStep.set(1);
      await new Promise<void>((r) => setTimeout(r, 380));
      if (this.usesInpainting()) {
        this.thinkingStep.set(2);
        await new Promise<void>((r) => setTimeout(r, 420));
        this.thinkingStep.set(3);
        await new Promise<void>((r) => setTimeout(r, 320));
        this.thinkingStep.set(4);
      } else {
        this.thinkingStep.set(2);
        await new Promise<void>((r) => setTimeout(r, 320));
        this.thinkingStep.set(3);
      }
      const can = this.booth.cans().find((c) => c.id === mode.id);
      const r = await window.pbApi.openAiGenerateImage({
        imagePath: source,
        prompt: mode.prompt,
        modeId: mode.id,
        useInpainting: mode.useInpainting === true,
        randomizeBackground: false,
        inpaintPrompt: mode.inpaintPrompt,
        face: can?.face,
      });
      if (!r.ok || !r.path) {
        this.aiErr.set(r.error ?? 'Generation failed.');
        return;
      }
      this.aiModelUsed.set(r.model ?? null);
      this.galleryUpload.queueUpload(r.path, 'ai');
      this.gallerySession.setPair(source, r.path);
      void this.router.navigate(['/ai-gallery']);
    } catch (e) {
      this.aiErr.set(String(e));
    } finally {
      this.stopAiCountdown();
      this.aiGenerating.set(false);
      this.thinkingStep.set(0);
    }
  }

  async openShare(): Promise<void> {
    const url = this.galleryUpload.shareUrlFor(this.sharePath());
    if (!url) return;
    this.shareBusy.set(true);
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        width: 320,
        margin: 2,
        color: { dark: '#1c1a17', light: '#ffffff' },
      });
      this.shareQrDataUrl.set(dataUrl);
      this.shareOpen.set(true);
    } catch (e) {
      this.aiErr.set(String(e));
    } finally {
      this.shareBusy.set(false);
    }
  }

  async retryShareUpload(): Promise<void> {
    const pp = this.sharePath();
    if (!pp) return;
    this.shareBusy.set(true);
    try {
      await this.galleryUpload.ensureShareUpload(pp);
    } finally {
      this.shareBusy.set(false);
    }
  }

  closeShare(): void {
    this.shareOpen.set(false);
  }

  async printOnce(): Promise<void> {
    if (!this.canPrint()) return;
    const pp = this.path();
    if (!pp || !window.pbApi?.printPhoto) {
      this.printErr.set('Printing requires Electron.');
      return;
    }
    this.printBusy.set(true);
    try {
      const deviceName = this.booth.print().printerName;
      const r = await window.pbApi.printPhoto({
        filePath: pp,
        deviceName: deviceName || undefined,
        layoutMode: this.printUsesPhysicalLayout() ? 'physicalFrame' : undefined,
      });
      if (!r.ok) {
        this.printErr.set(r.error ?? 'Print failed.');
        return;
      }
      this.printErr.set(null);
      this.printDone.set(true);
    } catch (e) {
      this.printErr.set(String(e));
    } finally {
      this.printBusy.set(false);
    }
  }

  openPhysicalAdjust(): void {
    if (!this.physicalAdjustSource()) {
      this.makePhysicalErr.set('Physical layout requires Electron.');
      return;
    }
    this.makePhysicalErr.set(null);
    this.physicalAdjustOpen.set(true);
  }

  async openMakeFramed(): Promise<void> {
    const src = this.physicalAdjustSource();
    if (!src) return;
    this.makeFramedBusy.set(true);
    try {
      await this.router.navigate(['/frame'], { state: { path: src, pickFrame: true } });
    } finally {
      this.makeFramedBusy.set(false);
    }
  }

  async onPhysicalAdjustConfirm(crop: PhysicalPhotoCrop): Promise<void> {
    const pp = this.path();
    const src = this.physicalAdjustSource();
    if (!pp || !src) {
      this.makePhysicalErr.set('Physical layout requires Electron.');
      return;
    }
    this.makePhysicalBusy.set(true);
    this.makePhysicalErr.set(null);
    try {
      const r = await this.physicalLayout.generate(src, crop);
      if (!r.ok || !r.path) {
        this.makePhysicalErr.set(r.error || 'Could not create physical sheet.');
        return;
      }
      if (!this.digitalPath() && !this.isPhysicalSheetPath(pp)) {
        this.digitalPath.set(pp);
      }
      this.path.set(r.path);
      try {
        history.replaceState({ ...(history.state || {}), path: r.path }, '');
      } catch {
        /* ignore */
      }
      this.printDone.set(false);
      this.printErr.set(null);
      this.imageDataUrl.set(null);
      this.resultAspectRatio.set(null);
      this.physicalAdjustOpen.set(false);
      if (window.pbApi?.readFileBase64) {
        this.imageDataUrl.set(await window.pbApi.readFileBase64(r.path));
      }
    } catch (e) {
      this.makePhysicalErr.set(String(e));
    } finally {
      this.makePhysicalBusy.set(false);
    }
  }

  isPhysicalSheetPath(p: string | null | undefined): boolean {
    return !!p && /_physical\.png$/i.test(p);
  }

  originalCapturePath(p: string): string {
    return p
      .replace(/_physical\.png$/i, '.jpg')
      .replace(/_ai\.png$/i, '.jpg')
      .replace(/_framed\.png$/i, '.jpg');
  }

  confirmPreview(): void {
    const pp = this.path();
    if (!pp) return;
    this.isPreview.set(false);
    try {
      history.replaceState({ ...(history.state || {}), path: pp, preview: false }, '');
    } catch {
      /* ignore */
    }
    this.galleryUpload.commitGuestCapture(pp);
    this.startShareUploadIfNeeded(pp);
  }

  retake(): void {
    this.gallerySession.clear();
    this.galleryUpload.clearGuestSession();
    this.aiErr.set(null);
    void this.camera.closeSession().catch(() => {});
    void this.router.navigate(['/capture']);
  }

  submit(): void {
    this.stopAiCountdown();
    this.gallerySession.clear();
    this.galleryUpload.clearGuestSession();
    this.aiStyle.clear();
    this.boothMode.clear();
    void this.camera.closeSession().catch(() => {});
    void this.router.navigate(['/']);
  }

  onResultImgLoad(ev: Event): void {
    const img = ev.target as HTMLImageElement;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      this.resultAspectRatio.set(img.naturalWidth / img.naturalHeight);
    }
  }

  ngOnDestroy(): void {
    this.stopAiCountdown();
    this.navSub?.unsubscribe();
    this.stopSharePoll();
  }

  private startAiCountdown(seconds: number): void {
    this.stopAiCountdown();
    this.aiEtaSec.set(seconds);
    this.aiElapsedSec.set(0);
    this.aiTimer = setInterval(() => {
      this.aiElapsedSec.update((v) => v + 1);
      this.aiEtaSec.update((v) => Math.max(0, v - 1));
    }, 1000);
  }

  private stopAiCountdown(): void {
    if (this.aiTimer) {
      clearInterval(this.aiTimer);
      this.aiTimer = undefined;
    }
  }

  private formatDuration(totalSec: number): string {
    const safe = Math.max(0, Math.floor(totalSec));
    const m = String(Math.floor(safe / 60)).padStart(2, '0');
    const s = String(safe % 60).padStart(2, '0');
    return `${m}:${s}`;
  }
}
