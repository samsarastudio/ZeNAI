import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { BoothConfigService } from './booth-config.service';
import { BoothLogService } from './booth-log.service';

export type GalleryPhotoVariant = 'original' | 'framed' | 'ai' | 'physical';

export interface GalleryUploadRecord {
  path: string;
  variant: GalleryPhotoVariant;
  photoId?: string;
  shareUrl?: string;
  url?: string;
  error?: string;
  status: 'pending' | 'queued' | 'ok' | 'error';
}

@Injectable({ providedIn: 'root' })
export class GalleryUploadService implements OnDestroy {
  private readonly booth = inject(BoothConfigService);
  private readonly log = inject(BoothLogService);

  private readonly byPath = signal<Record<string, GalleryUploadRecord>>({});
  /** Bumps whenever upload state changes — keeps result Share UI reactive. */
  readonly revision = signal(0);
  readonly sessionSlug = signal<string | null>(null);
  readonly galleryUrl = signal<string | null>(null);
  readonly lastError = signal<string | null>(null);

  readonly enabled = computed(() => {
    const g = this.booth.gallery();
    return g.enabled && !!g.apiBaseUrl && !!g.uploadToken;
  });

  private onlineHandler = () => {
    void this.flushQueue();
    void this.syncFramesFromMoments();
  };
  private unsubQueue?: () => void;
  private framesSyncInFlight: Promise<void> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
      this.unsubQueue = window.pbApi?.onGalleryUploadQueueUpdated?.((item) => {
        this.applyQueueItem(item);
      });
    }
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
    }
    this.unsubQueue?.();
  }

  /**
   * Non-blocking: pull latest Moments frames (and drop local copies removed on the server),
   * then drain any queued photo uploads. Safe to call while offline — no-ops.
   */
  startBackgroundSync(): void {
    void this.syncFramesFromMoments();
    void this.flushQueue();
  }

  /** Server is source of truth. Offline keeps whatever is already on disk. */
  async syncFramesFromMoments(): Promise<void> {
    if (!window.pbApi?.gallerySyncFrames) return;
    const g = this.booth.gallery();
    const apiBaseUrl = (g.apiBaseUrl || '').replace(/\/$/, '');
    if (!apiBaseUrl) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (this.framesSyncInFlight) return this.framesSyncInFlight;
    this.framesSyncInFlight = (async () => {
      try {
        const r = await window.pbApi!.gallerySyncFrames!({
          apiBaseUrl,
          uploadToken: undefined,
          pushLocal: false,
          pruneLocal: true,
          timeoutMs: 20000,
        });
        if (r.ok) {
          void this.log.info('frames', 'moments sync ok', {
            pulled: r.count ?? 0,
            skipped: r.skippedCount ?? 0,
            pruned: r.prunedCount ?? r.pruned?.length ?? 0,
          });
        } else if (r.offline) {
          void this.log.warn('frames', 'moments unreachable — using local frames');
        } else if (r.error) {
          void this.log.warn('frames', 'moments sync failed', { error: r.error });
        }
      } catch (e) {
        void this.log.warn('frames', 'moments sync error', { error: String(e) });
      } finally {
        this.framesSyncInFlight = null;
      }
    })();
    return this.framesSyncInFlight;
  }

  private bump(): void {
    this.revision.update((n) => n + 1);
  }

  /** Rewrite Pi-local or wrong-port share links using Admin → Gallery API base URL. */
  private normalizeShareUrl(shareUrl: string | undefined): string | undefined {
    if (!shareUrl) return shareUrl;
    const base = (this.booth.gallery().apiBaseUrl || '').replace(/\/$/, '');
    if (!base) return shareUrl;
    try {
      const u = new URL(shareUrl);
      const b = new URL(base.endsWith('/') ? base : `${base}/`);
      const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
      const sameHost = u.hostname === b.hostname;
      if (!local && !sameHost) return shareUrl;
      const path = `${u.pathname}${u.search}${u.hash}`;
      return new URL(path, `${b.protocol}//${b.host}`).toString();
    } catch {
      /* keep original */
    }
    return shareUrl;
  }

  recordFor(path: string | null | undefined): GalleryUploadRecord | null {
    void this.revision();
    if (!path) return null;
    return this.byPath()[path] ?? null;
  }

  shareUrlFor(path: string | null | undefined): string | null {
    const r = this.recordFor(path);
    const url = r?.status === 'ok' && r.shareUrl ? r.shareUrl : null;
    return url ? this.normalizeShareUrl(url) ?? null : null;
  }

  clearGuestSession(): void {
    this.byPath.set({});
    this.lastError.set(null);
    this.bump();
  }

  todaySlug(): string {
    const prefix = this.booth.gallery().sessionPrefix || 'session';
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${prefix}-${y}-${m}-${day}`;
  }

  async ensureDaySession(): Promise<{ ok: boolean; slug?: string; galleryUrl?: string; error?: string }> {
    if (!this.enabled() || !window.pbApi?.galleryEnsureDaySession) {
      return { ok: false, error: 'Gallery upload disabled' };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { ok: false, error: 'Offline' };
    }
    const g = this.booth.gallery();
    try {
      const r = await window.pbApi.galleryEnsureDaySession({
        apiBaseUrl: g.apiBaseUrl,
        uploadToken: g.uploadToken,
        eventPrefix: g.sessionPrefix,
      });
      if (r.ok) {
        this.sessionSlug.set(r.slug ?? this.todaySlug());
        this.galleryUrl.set(r.galleryUrl ?? null);
      } else {
        this.lastError.set(r.error ?? 'Session ensure failed');
      }
      return r;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  private applyQueueItem(item: {
    filePath?: string;
    variant?: string;
    status?: string;
    photoId?: string;
    shareUrl?: string;
    url?: string;
    error?: string;
  } | null): void {
    if (!item?.filePath) return;
    const status =
      item.status === 'ok' || item.status === 'error' || item.status === 'pending' || item.status === 'queued'
        ? item.status
        : 'queued';
    const rec: GalleryUploadRecord = {
      path: item.filePath,
      variant: (item.variant as GalleryPhotoVariant) || this.inferVariant(item.filePath),
      status,
      photoId: item.photoId,
      shareUrl: this.normalizeShareUrl(item.shareUrl),
      url: item.url,
      error: item.error,
    };
    this.byPath.update((m) => ({ ...m, [item.filePath!]: rec }));
    if (status === 'error') this.lastError.set(item.error ?? null);
    this.bump();
  }

  async flushQueue(): Promise<void> {
    if (!this.enabled() || !window.pbApi?.galleryFlushUploadQueue) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      await window.pbApi.galleryFlushUploadQueue();
    } catch {
      /* offline flush is best-effort */
    }
  }

  async uploadPath(
    filePath: string,
    variant: GalleryPhotoVariant,
  ): Promise<GalleryUploadRecord> {
    const pending: GalleryUploadRecord = { path: filePath, variant, status: 'queued' };
    this.byPath.update((m) => ({ ...m, [filePath]: pending }));
    this.bump();

    if (!this.enabled() || !window.pbApi?.galleryUploadPhoto) {
      const err: GalleryUploadRecord = {
        ...pending,
        status: 'error',
        error: 'Gallery upload disabled',
      };
      this.byPath.update((m) => ({ ...m, [filePath]: err }));
      this.bump();
      return err;
    }

    const g = this.booth.gallery();
    void this.log.info('gallery', `upload start (${variant})`, { filePath });
    // Cloud gallery is AI-result only — never push raw captures / framed / physical.
    if (variant !== 'ai') return this.skip(filePath, variant);
    if (!g.uploadAi) return this.skip(filePath, variant);

    const r = await window.pbApi.galleryUploadPhoto({
      apiBaseUrl: g.apiBaseUrl,
      uploadToken: g.uploadToken,
      eventPrefix: g.sessionPrefix,
      filePath,
      variant,
    });

    const next: GalleryUploadRecord = r.ok
      ? {
          path: filePath,
          variant,
          status: 'ok',
          photoId: r.photoId,
          shareUrl: this.normalizeShareUrl(r.shareUrl),
          url: r.url,
        }
      : r.queued || r.status === 'queued' || r.status === 'pending'
        ? {
            path: filePath,
            variant,
            status: 'queued',
            error: r.error,
          }
        : {
            path: filePath,
            variant,
            status: 'error',
            error: r.error ?? 'Upload failed',
          };
    this.byPath.update((m) => ({ ...m, [filePath]: next }));
    if (next.status === 'error') this.lastError.set(next.error ?? null);
    if (next.status === 'ok') {
      void this.log.info('gallery', `upload ok (${variant})`, {
        photoId: next.photoId,
        shareUrl: next.shareUrl,
      });
    } else if (next.status === 'queued') {
      void this.log.warn('gallery', `upload queued (${variant})`, { error: next.error });
    } else {
      void this.log.error('gallery', `upload error (${variant})`, { error: next.error });
    }
    this.bump();
    return next;
  }

  /** Infer variant from capture filename conventions. */
  inferVariant(filePath: string): GalleryPhotoVariant {
    const base = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
    if (base.includes('_ai.') || base.endsWith('_ai.png')) return 'ai';
    if (base.includes('_physical.') || base.includes('_physical_')) return 'physical';
    if (base.includes('_framed.') || base.includes('_framed_')) return 'framed';
    return 'original';
  }

  /** Ensure the photo shown on result is uploaded so Share can enable. */
  async ensureShareUpload(filePath: string): Promise<GalleryUploadRecord | null> {
    if (!this.enabled() || !filePath) return null;

    await this.syncFromDisk(filePath);
    let existing = this.byPath()[filePath];
    if (existing?.status === 'ok' && existing.shareUrl) return existing;

    if (existing?.status === 'pending' || existing?.status === 'queued') {
      await this.flushQueue();
      await this.syncFromDisk(filePath);
      existing = this.byPath()[filePath];
      if (existing?.status === 'ok' && existing.shareUrl) return existing;
      if (existing?.status === 'error') return existing;
      // Still in flight / queued offline — do not POST a duplicate.
      return existing ?? null;
    }

    if (existing?.status === 'error') {
      return this.uploadPath(filePath, this.inferVariant(filePath));
    }

    // No local record yet — first upload for this path.
    return this.uploadPath(filePath, this.inferVariant(filePath));
  }

  private async syncFromDisk(filePath: string): Promise<void> {
    if (!window.pbApi?.galleryGetUploadQueueItem) return;
    try {
      const r = await window.pbApi.galleryGetUploadQueueItem(filePath);
      if (r?.ok && r.item) {
        // Alias under the UI path so Share state matches the result screen key.
        this.applyQueueItem({ ...r.item, filePath });
      }
    } catch {
      /* ignore */
    }
  }

  /** Fire-and-forget helper for capture/frame/AI hooks. */
  queueUpload(filePath: string, variant: GalleryPhotoVariant): void {
    void this.uploadPath(filePath, variant);
  }

  /**
   * Upload the guest's chosen photo (and its original, if this is a framed /
   * physical / AI derivative) after they tap Done on the preview screen.
   */
  commitGuestCapture(displayPath: string): void {
    if (!displayPath) return;
    const variant = this.inferVariant(displayPath);
    const original = displayPath
      .replace(/_physical\.png$/i, '.jpg')
      .replace(/_ai\.png$/i, '.jpg')
      .replace(/_framed\.png$/i, '.jpg');
    if (original !== displayPath) {
      this.queueUpload(original, 'original');
    }
    this.queueUpload(displayPath, variant);
  }

  private skip(filePath: string, variant: GalleryPhotoVariant): GalleryUploadRecord {
    const rec: GalleryUploadRecord = {
      path: filePath,
      variant,
      status: 'error',
      error: `Upload of ${variant} disabled`,
    };
    this.byPath.update((m) => ({ ...m, [filePath]: rec }));
    this.bump();
    return rec;
  }

  /** Surface a retryable error when upload never leaves pending/queued. */
  markUploadTimedOut(filePath: string | null | undefined): void {
    if (!filePath) return;
    const cur = this.byPath()[filePath];
    if (cur?.status === 'ok') return;
    const rec: GalleryUploadRecord = {
      path: filePath,
      variant: cur?.variant || this.inferVariant(filePath),
      status: 'error',
      error: cur?.error || 'Upload timed out — tap to retry',
      photoId: cur?.photoId,
      shareUrl: cur?.shareUrl,
      url: cur?.url,
    };
    this.byPath.update((m) => ({ ...m, [filePath]: rec }));
    this.lastError.set(rec.error ?? null);
    this.bump();
  }
}
