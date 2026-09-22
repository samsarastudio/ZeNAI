import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BoothConfigService } from '../../services/booth-config.service';
import { AiGallerySessionService } from '../../services/ai-gallery-session.service';
import { AiStyleService } from '../../services/ai-style.service';
import { CameraService } from '../../services/camera.service';

import { PrintTroubleDialogComponent } from '../../components/print-trouble-dialog/print-trouble-dialog.component';

@Component({
  selector: 'pb-ai-gallery-page',
  imports: [RouterLink, PrintTroubleDialogComponent],
  templateUrl: './ai-gallery-page.component.html',
  styleUrl: './ai-gallery-page.component.scss',
})
export class AiGalleryPageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly router = inject(Router);
  private readonly session = inject(AiGallerySessionService);
  private readonly aiStyle = inject(AiStyleService);
  private readonly camera = inject(CameraService);

  readonly copy = this.booth.copy;

  /** Which image is shown large — thumbnails pick the other. */
  readonly heroKind = signal<'original' | 'ai'>('ai');

  readonly originalDataUrl = signal<string | null>(null);
  readonly aiDataUrl = signal<string | null>(null);
  readonly err = signal<string | null>(null);
  readonly heroAspectRatio = signal<number | null>(null);

  readonly printBusy = signal(false);
  readonly printDone = signal(false);
  readonly printErr = signal<string | null>(null);

  readonly heroSrc = computed(() =>
    this.heroKind() === 'original' ? this.originalDataUrl() : this.aiDataUrl(),
  );
  readonly showPrint = computed(() => this.booth.print().enabled === true);
  readonly printPath = computed(() =>
    this.heroKind() === 'original' ? this.session.originalPath() : this.session.aiPath(),
  );
  readonly canPrint = computed(
    () => this.showPrint() && !!this.printPath() && !this.printBusy() && !this.printDone(),
  );

  async ngOnInit(): Promise<void> {
    if (!this.session.hasPair()) {
      void this.router.navigate(['/result']);
      return;
    }
    const orig = this.session.originalPath()!;
    const ai = this.session.aiPath()!;
    if (!window.pbApi?.readFileBase64) {
      this.err.set('Gallery needs Electron.');
      return;
    }
    try {
      const [o, a] = await Promise.all([
        window.pbApi.readFileBase64(orig),
        window.pbApi.readFileBase64(ai),
      ]);
      this.originalDataUrl.set(o);
      this.aiDataUrl.set(a);
    } catch (e) {
      this.err.set(String(e));
    }
  }

  pickHero(kind: 'original' | 'ai'): void {
    this.heroKind.set(kind);
    this.heroAspectRatio.set(null);
  }

  async printOnce(): Promise<void> {
    if (!this.canPrint()) return;
    const pp = this.printPath();
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

  onHeroLoad(ev: Event): void {
    const img = ev.target as HTMLImageElement;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      this.heroAspectRatio.set(img.naturalWidth / img.naturalHeight);
    }
  }

  backToResult(): void {
    const p = this.session.originalPath();
    if (p) {
      void this.router.navigate(['/result'], { state: { path: p } });
    } else {
      void this.router.navigate(['/result']);
    }
  }

  async finish(): Promise<void> {
    this.session.clear();
    this.aiStyle.clear();
    await this.camera.closeSession().catch(() => {});
    void this.router.navigate(['/']);
  }
}
