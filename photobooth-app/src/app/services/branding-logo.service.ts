import { Injectable, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

@Injectable({ providedIn: 'root' })
export class BrandingLogoService {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly rawUrl = signal<string | null>(null);
  private readonly aiRawUrl = signal<string | null>(null);
  private readonly overlayRawUrl = signal<string | null>(null);
  private readonly overlaySource = signal<'custom' | 'default' | 'none'>('none');

  /** App UI logo for attract / QR / style picker. */
  readonly logoSrc = computed((): SafeResourceUrl | null => {
    const raw = this.rawUrl();
    return raw ? this.sanitizer.bypassSecurityTrustResourceUrl(raw) : null;
  });

  /** AI reference logo preview (admin + internal use). */
  readonly aiLogoSrc = computed((): SafeResourceUrl | null => {
    const raw = this.aiRawUrl();
    return raw ? this.sanitizer.bypassSecurityTrustResourceUrl(raw) : null;
  });

  /** Capture pose guideline (custom branding file, else bundled waist-up default). */
  readonly cameraOverlaySrc = computed((): SafeResourceUrl | null => {
    const raw = this.overlayRawUrl();
    return raw ? this.sanitizer.bypassSecurityTrustResourceUrl(raw) : null;
  });

  /** Plain URL for `<img [src]>` when SafeResourceUrl is not needed. */
  readonly cameraOverlayUrl = computed(() => this.overlayRawUrl());

  readonly cameraOverlaySource = computed(() => this.overlaySource());

  readonly hasLogo = computed(() => this.rawUrl() !== null);
  readonly hasAiLogo = computed(() => this.aiRawUrl() !== null);
  readonly hasCustomCameraOverlay = computed(() => this.overlaySource() === 'custom');

  async refresh(): Promise<void> {
    if (!window.pbApi?.adminGetBrandingLogoUrl) {
      this.rawUrl.set(null);
      return;
    }
    const r = await window.pbApi.adminGetBrandingLogoUrl();
    const url = r.ok && r.url ? r.url : null;
    this.rawUrl.set(url);
  }

  async refreshAiLogo(): Promise<void> {
    if (!window.pbApi?.adminGetAiBrandLogoUrl) {
      this.aiRawUrl.set(null);
      return;
    }
    const r = await window.pbApi.adminGetAiBrandLogoUrl();
    const url = r.ok && r.url ? r.url : null;
    this.aiRawUrl.set(url);
  }

  async refreshCameraOverlay(): Promise<void> {
    if (!window.pbApi?.adminGetCameraOverlayUrl) {
      this.overlayRawUrl.set('zyn/cameraoverlay.png');
      this.overlaySource.set('default');
      return;
    }
    const r = await window.pbApi.adminGetCameraOverlayUrl();
    if (r.ok && r.url) {
      this.overlayRawUrl.set(r.url);
      this.overlaySource.set(r.source === 'custom' ? 'custom' : 'default');
      return;
    }
    this.overlayRawUrl.set('zyn/cameraoverlay.png');
    this.overlaySource.set('default');
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refresh(), this.refreshAiLogo(), this.refreshCameraOverlay()]);
  }
}
