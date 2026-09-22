import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { VirtualKeyboardComponent } from '../../components/virtual-keyboard/virtual-keyboard.component';
import { BoothConfigService } from '../../services/booth-config.service';

@Component({
  selector: 'pb-caption-page',
  imports: [VirtualKeyboardComponent],
  templateUrl: './caption-page.component.html',
  styleUrl: './caption-page.component.scss',
})
export class CaptionPageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly router = inject(Router);
  readonly copy = this.booth.copy;

  readonly photoPath = signal<string | null>(null);
  readonly frameFile = signal<string | null>(null);
  readonly cropZoom = signal<number | undefined>(undefined);
  readonly cropPanX = signal<number | undefined>(undefined);
  readonly cropPanY = signal<number | undefined>(undefined);
  readonly text = signal('');
  readonly busy = signal(false);
  readonly err = signal<string | null>(null);

  readonly framesCfg = this.booth.photoFrames;
  readonly maxLen = computed(() => this.framesCfg().guestTextMaxLength || 36);
  readonly optional = computed(() => this.framesCfg().guestTextOptional !== false);
  readonly credit = computed(() => (this.framesCfg().guestTextCreditLine || '').trim());
  readonly remaining = computed(() => Math.max(0, this.maxLen() - this.text().length));

  constructor() {
    const nav = this.router.getCurrentNavigation();
    const st = nav?.extras?.state as {
      path?: string;
      frameFile?: string;
      cropZoom?: number;
      cropPanX?: number;
      cropPanY?: number;
    } | undefined;
    if (st?.path) this.photoPath.set(st.path);
    if (st?.frameFile) this.frameFile.set(st.frameFile);
    if (st) this.cropFromNav(st);
  }

  async ngOnInit(): Promise<void> {
    if (!this.photoPath() || !this.frameFile()) {
      const st = history.state as {
        path?: string;
        frameFile?: string;
        cropZoom?: number;
        cropPanX?: number;
        cropPanY?: number;
      };
      if (st?.path) this.photoPath.set(st.path);
      if (st?.frameFile) this.frameFile.set(st.frameFile);
      this.cropFromNav(st);
    }
    if (!this.photoPath() || !this.frameFile()) {
      this.err.set('Missing photo or frame — go back and try again.');
      return;
    }
    if (!this.framesCfg().enabled || !this.framesCfg().guestTextEnabled) {
      await this.applyAndGo(this.text());
    }
  }

  onText(next: string): void {
    this.text.set(next.slice(0, this.maxLen()));
  }

  async continue(): Promise<void> {
    await this.applyAndGo(this.text().trim());
  }

  async skip(): Promise<void> {
    if (!this.optional()) return;
    await this.applyAndGo('');
  }

  private async applyAndGo(guestText: string): Promise<void> {
    const photo = this.photoPath();
    const frame = this.frameFile();
    if (!photo || !frame || !window.pbApi?.applyPhotoFrame) return;
    this.busy.set(true);
    this.err.set(null);
    try {
      const r = await window.pbApi.applyPhotoFrame({
        imagePath: photo,
        frameFile: frame,
        photoScale: this.framesCfg().photoScale,
        guestText: guestText || undefined,
        creditLine: guestText ? this.credit() || undefined : undefined,
        cropZoom: this.cropZoom(),
        cropPanX: this.cropPanX(),
        cropPanY: this.cropPanY(),
      });
      if (r.ok && r.path) {
        await this.router.navigate(['/result'], { state: { path: r.path, preview: true } });
      } else {
        this.err.set(r.error ?? 'Could not apply frame text.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  private cropFromNav(st: {
    cropZoom?: number;
    cropPanX?: number;
    cropPanY?: number;
  } | undefined): void {
    if (!st) return;
    if (typeof st.cropZoom === 'number') this.cropZoom.set(st.cropZoom);
    if (typeof st.cropPanX === 'number') this.cropPanX.set(st.cropPanX);
    if (typeof st.cropPanY === 'number') this.cropPanY.set(st.cropPanY);
  }
}
