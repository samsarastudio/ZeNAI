import { Injectable, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

@Injectable({ providedIn: 'root' })
export class BrandingLogoService {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly rawUrl = signal<string | null>(null);
  private readonly aiRawUrl = signal<string | null>(null);

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

  readonly hasLogo = computed(() => this.rawUrl() !== null);
  readonly hasAiLogo = computed(() => this.aiRawUrl() !== null);

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

  async refreshAll(): Promise<void> {
    await Promise.all([this.refresh(), this.refreshAiLogo()]);
  }
}
