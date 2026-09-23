import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BoothConfigService } from '../../services/booth-config.service';
import { GuestSessionService } from '../../services/guest-session.service';
import { BrandingLogoService } from '../../services/branding-logo.service';

function isApiKeyError(err: string | null | undefined): boolean {
  return /api key not configured|openai api key|api key missing/i.test(String(err || ''));
}

@Component({
  selector: 'pb-thanks-page',
  templateUrl: './thanks-page.component.html',
  styleUrl: './thanks-page.component.scss',
})
export class ThanksPageComponent implements OnInit, OnDestroy {
  private readonly booth = inject(BoothConfigService);
  private readonly session = inject(GuestSessionService);
  private readonly router = inject(Router);
  readonly branding = inject(BrandingLogoService);
  readonly copy = this.booth.copy;

  readonly aiStatus = signal<string>('queued');
  readonly printStatus = signal<string>('idle');
  readonly uploadStatus = signal<string>('idle');
  readonly lastError = signal<string | null>(null);
  readonly backendReachable = signal<boolean | null>(null);
  readonly printEnabled = computed(() => this.booth.print().enabled !== false);
  readonly headline = computed(() => {
    const c = this.copy().thanks;
    const ai = this.aiStatus();
    if (ai === 'failed' && isApiKeyError(this.lastError())) {
      return c.apiKeyMissing || 'API KEY MISSING';
    }
    if (ai === 'failed') return c.printError || 'SOMETHING WENT WRONG';
    if (this.printEnabled() && this.printStatus() === 'failed') {
      return c.printError || 'SOMETHING WENT WRONG';
    }
    // Match reference screen-6: always "YOUR PHOTO / IS PRINTING"
    return c.printed || c.processing || c.title || 'YOUR PHOTO\nIS PRINTING';
  });

  /** Guest-facing hint — errors only (no AI/upload phase chatter). */
  readonly guestStatusHint = computed(() => {
    const err = this.lastError();
    const print = this.printStatus();
    if (this.printEnabled() && print === 'failed') {
      return err || this.copy().thanks.printError || 'Set a printer in Admin → Print.';
    }
    if (this.aiStatus() === 'failed' && err) return err;
    return '';
  });

  readonly statusHint = this.guestStatusHint;

  private homeTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private unsubJobs?: () => void;

  ngOnInit(): void {
    void this.refreshJob();
    void this.pingBackend();
    this.pollTimer = setInterval(() => {
      void this.refreshJob();
      void this.pingBackend();
    }, 1500);
    if (window.pbApi?.onJobsUpdated) {
      this.unsubJobs = window.pbApi.onJobsUpdated(() => {
        void this.refreshJob();
      });
    }
    this.homeTimer = setTimeout(() => this.resetHome(), 12000);
  }

  startOver(): void {
    this.resetHome();
  }

  private async refreshJob(): Promise<void> {
    const id = this.session.jobId();
    if (!id || !window.pbApi?.jobsGet) return;
    try {
      const r = await window.pbApi.jobsGet(id);
      const job = r.job;
      if (!job) return;
      this.aiStatus.set(String(job['aiStatus'] || 'queued'));
      this.printStatus.set(String(job['printStatus'] || 'idle'));
      this.uploadStatus.set(String(job['uploadStatus'] || 'idle'));
      this.lastError.set(job['lastError'] ? String(job['lastError']) : null);
    } catch {
      /* ignore poll errors */
    }
  }

  private async pingBackend(): Promise<void> {
    if (!this.booth.gallery().enabled) {
      this.backendReachable.set(null);
      return;
    }
    if (!window.pbApi?.galleryPing) {
      this.backendReachable.set(null);
      return;
    }
    try {
      const r = await window.pbApi.galleryPing();
      if (r.skipped || r.enabled === false) {
        this.backendReachable.set(null);
        return;
      }
      this.backendReachable.set(!!r.reachable);
    } catch {
      this.backendReachable.set(false);
    }
  }

  private resetHome(): void {
    if (this.homeTimer) {
      clearTimeout(this.homeTimer);
      this.homeTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.unsubJobs?.();
    this.unsubJobs = undefined;
    this.session.clear();
    void this.router.navigate(['/']);
  }

  ngOnDestroy(): void {
    if (this.homeTimer) clearTimeout(this.homeTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubJobs?.();
  }
}
