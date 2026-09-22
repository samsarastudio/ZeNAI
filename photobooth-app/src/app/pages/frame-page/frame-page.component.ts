import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BoothConfigService } from '../../services/booth-config.service';
import { GalleryUploadService } from '../../services/gallery-upload.service';
import { FrameAdjustDialogComponent } from '../../components/frame-adjust-dialog/frame-adjust-dialog.component';
import type { PhysicalPhotoCrop } from '../../models/physical-frame-layout';

interface FrameItem {
  filename: string;
  label: string;
  url: string;
}

@Component({
  selector: 'pb-frame-page',
  imports: [FrameAdjustDialogComponent],
  templateUrl: './frame-page.component.html',
  styleUrl: './frame-page.component.scss',
})
export class FramePageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly galleryUpload = inject(GalleryUploadService);
  private readonly router = inject(Router);
  readonly copy = this.booth.copy;

  readonly photoPath = signal<string | null>(null);
  readonly frames = signal<FrameItem[]>([]);
  readonly selected = signal<string | null>(null);
  readonly busy = signal(false);
  readonly err = signal<string | null>(null);
  readonly pickFrameMode = signal(false);
  readonly adjustOpen = signal(false);
  readonly pendingCrop = signal<PhysicalPhotoCrop | null>(null);

  readonly selectedFrame = computed(() => {
    const id = this.selected();
    return this.frames().find((f) => f.filename === id) ?? null;
  });

  readonly shouldAdjust = computed(
    () => this.pickFrameMode() || this.booth.photoFrames().guestAdjustPhoto,
  );

  constructor() {
    const nav = this.router.getCurrentNavigation();
    const st = nav?.extras?.state as { path?: string; pickFrame?: boolean } | undefined;
    if (st?.path) this.photoPath.set(st.path);
    if (st?.pickFrame) this.pickFrameMode.set(true);
  }

  async ngOnInit(): Promise<void> {
    if (!this.photoPath()) {
      const st = history.state as { path?: string; pickFrame?: boolean };
      if (st?.path) this.photoPath.set(st.path);
      if (st?.pickFrame) this.pickFrameMode.set(true);
    }
    if (!this.photoPath()) {
      this.err.set('No photo — go back and capture again.');
      return;
    }
    const framesCfg = this.booth.photoFrames();
    const pickFrame = this.pickFrameMode();
    if (!framesCfg.enabled && !pickFrame) {
      await this.router.navigate(['/result'], { state: { path: this.photoPath(), preview: true } });
      return;
    }
    // Auto-apply: pick a frame silently. Adjust (if on) still shows so faces can be aligned.
    if (framesCfg.autoApplyFrame && !pickFrame) {
      await this.loadFrames();
      if (this.frames().length > 0) {
        await this.applySelected();
      }
      return;
    }
    await this.loadFrames();
  }

  private async loadFrames(): Promise<void> {
    if (!window.pbApi?.listPhotoFrames) {
      this.err.set('Frames require Electron.');
      return;
    }
    this.galleryUpload.startBackgroundSync();
    const r = await window.pbApi.listPhotoFrames();
    if (!r.ok || !r.frames?.length) {
      this.err.set(r.error ?? 'No frames found. Add PNGs under config/photo-frames/.');
      return;
    }
    const allow = this.booth.photoFrames().guestFrameFiles ?? [];
    let available = r.frames;
    if (allow.includes('__none__') && !this.pickFrameMode()) {
      this.err.set('No frames are enabled for guests. Ask an operator to enable frames in Admin → Frames.');
      return;
    }
    if (allow.length > 0 && !allow.includes('__none__') && !this.pickFrameMode()) {
      available = r.frames.filter((f) => allow.includes(f.filename));
    }
    if (!available.length) {
      this.err.set('No enabled frames for guests. Enable at least one in Admin → Frames.');
      return;
    }
    this.frames.set(
      available.map((f) => ({
        filename: f.filename,
        label: f.label || f.filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
        url: f.url,
      })),
    );
    const def = this.booth.photoFrames().defaultFrameFile;
    const pick =
      (def && this.frames().some((f) => f.filename === def) && def) ||
      this.frames()[0]?.filename ||
      null;
    this.selected.set(pick);
  }

  selectFrame(filename: string): void {
    this.selected.set(filename);
  }

  async applySelected(): Promise<void> {
    const photo = this.photoPath();
    const frame = this.selected();
    if (!photo || !frame || !window.pbApi?.applyPhotoFrame) return;

    if (this.shouldAdjust() && !this.pendingCrop()) {
      this.adjustOpen.set(true);
      return;
    }

    if (this.booth.photoFrames().guestTextEnabled && !this.pickFrameMode()) {
      const crop = this.pendingCrop();
      await this.router.navigate(['/caption'], {
        state: {
          path: photo,
          frameFile: frame,
          cropZoom: crop?.zoom,
          cropPanX: crop?.panX,
          cropPanY: crop?.panY,
        },
      });
      return;
    }

    this.busy.set(true);
    this.err.set(null);
    try {
      const crop = this.pendingCrop();
      const r = await window.pbApi.applyPhotoFrame({
        imagePath: photo,
        frameFile: frame,
        photoScale: this.booth.photoFrames().photoScale,
        cropZoom: crop?.zoom,
        cropPanX: crop?.panX,
        cropPanY: crop?.panY,
      });
      if (r.ok && r.path) {
        const preview = !this.pickFrameMode();
        if (!preview) {
          this.galleryUpload.queueUpload(photo, 'original');
          this.galleryUpload.queueUpload(r.path, 'framed');
        }
        await this.router.navigate(['/result'], { state: { path: r.path, preview } });
      } else {
        this.err.set(r.error ?? 'Could not apply frame.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  onAdjustConfirm(crop: PhysicalPhotoCrop): void {
    this.pendingCrop.set(crop);
    this.adjustOpen.set(false);
    void this.applySelected();
  }

  onAdjustCancel(): void {
    this.adjustOpen.set(false);
    this.pendingCrop.set(null);
  }

  async skipFrame(): Promise<void> {
    const photo = this.photoPath();
    if (!photo) return;
    const preview = !this.pickFrameMode();
    if (!preview) {
      this.galleryUpload.queueUpload(photo, 'original');
    }
    await this.router.navigate(['/result'], { state: { path: photo, preview } });
  }
}
