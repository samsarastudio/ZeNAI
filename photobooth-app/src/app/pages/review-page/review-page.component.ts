import { Component, OnInit, inject, signal } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { BoothConfigService } from '../../services/booth-config.service';
import { GuestSessionService } from '../../services/guest-session.service';
import { BrandingLogoService } from '../../services/branding-logo.service';

@Component({
  selector: 'pb-review-page',
  templateUrl: './review-page.component.html',
  styleUrl: './review-page.component.scss',
})
export class ReviewPageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly session = inject(GuestSessionService);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  readonly branding = inject(BrandingLogoService);
  readonly copy = this.booth.copy;

  readonly previewUrl = signal<SafeUrl | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const path = this.session.capturePath();
    if (!this.session.canId() || !path) {
      await this.router.navigate(['/capture']);
      return;
    }
    if (!window.pbApi?.readFileBase64) {
      this.error.set('Preview requires Electron.');
      return;
    }
    try {
      const url = await window.pbApi.readFileBase64(path);
      this.previewUrl.set(this.sanitizer.bypassSecurityTrustUrl(url));
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async retake(): Promise<void> {
    this.session.setCapturePath(null);
    this.session.consents.set({ terms: false, age: false, imageUse: false, marketing: false });
    await this.router.navigate(['/capture']);
  }

  async confirm(): Promise<void> {
    if (this.busy()) return;
    const filePath = this.session.capturePath();
    if (!filePath) {
      await this.router.navigate(['/capture']);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await window.pbApi?.jobsEnqueue?.({
        capturePath: filePath,
        canId: this.session.canId(),
        canLabel: this.session.canLabel(),
        email: this.session.email(),
        firstName: this.session.firstName(),
        lastName: this.session.lastName(),
        consents: { ...this.session.consents() },
        tags: this.session.canId() ? [this.session.canId() as string] : [],
      });
      const jobId = r?.ok && r.job && typeof r.job['id'] === 'string' ? r.job['id'] : null;
      this.session.jobId.set(jobId);
      if (this.booth.showPreviewAfterGenerate() && jobId) {
        await this.router.navigate(['/preview']);
        return;
      }
      await this.router.navigate(['/thanks']);
    } catch (e) {
      this.error.set(String(e));
      this.busy.set(false);
    }
  }
}
