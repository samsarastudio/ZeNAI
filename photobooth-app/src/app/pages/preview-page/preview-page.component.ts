import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BoothConfigService } from '../../services/booth-config.service';
import { GuestSessionService } from '../../services/guest-session.service';

@Component({
  selector: 'pb-preview-page',
  templateUrl: './preview-page.component.html',
  styleUrl: './preview-page.component.scss',
})
export class PreviewPageComponent implements OnInit, OnDestroy {
  private readonly booth = inject(BoothConfigService);
  private readonly session = inject(GuestSessionService);
  private readonly router = inject(Router);
  readonly copy = this.booth.copy;

  readonly status = signal('Generating…');
  readonly err = signal<string | null>(null);
  readonly captureUrl = signal<string | null>(null);
  readonly aiUrl = signal<string | null>(null);
  readonly ready = signal(false);

  private timer?: ReturnType<typeof setInterval>;
  private unsub?: () => void;
  private destroyed = false;

  async ngOnInit(): Promise<void> {
    const id = this.session.jobId();
    if (!id) {
      await this.router.navigate(['/thanks']);
      return;
    }
    this.unsub = window.pbApi?.onJobsUpdated?.(() => {
      void this.refresh(id);
    });
    await this.refresh(id);
    this.timer = setInterval(() => void this.refresh(id), 1500);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.unsub?.();
  }

  async continue(): Promise<void> {
    await this.router.navigate(['/thanks']);
  }

  private async refresh(id: string): Promise<void> {
    if (this.destroyed) return;
    const r = await window.pbApi?.jobsGet?.(id);
    if (!r?.ok || !r.job) return;
    const job = r.job;
    const aiStatus = String(job['aiStatus'] || '');
    const lastError = typeof job['lastError'] === 'string' ? job['lastError'] : null;
    if (aiStatus === 'queued') this.status.set('Queued for AI…');
    if (aiStatus === 'running') this.status.set('Generating…');
    if (aiStatus === 'failed') {
      this.status.set('Generation failed');
      this.err.set(lastError);
      this.ready.set(true);
      this.stopPoll();
    }
    const capturePath = typeof job['capturePath'] === 'string' ? job['capturePath'] : null;
    const aiPath = typeof job['aiPath'] === 'string' ? job['aiPath'] : null;
    if (capturePath && !this.captureUrl()) {
      const b64 = await window.pbApi?.readFileThumbBase64?.(capturePath, 720);
      if (b64) this.captureUrl.set(b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`);
    }
    if (aiStatus === 'done' && aiPath) {
      const b64 = await window.pbApi?.readFileBase64?.(aiPath);
      if (b64) this.aiUrl.set(b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`);
      this.status.set('Ready — check the generated image');
      this.err.set(null);
      this.ready.set(true);
      this.stopPoll();
    }
  }

  private stopPoll(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
