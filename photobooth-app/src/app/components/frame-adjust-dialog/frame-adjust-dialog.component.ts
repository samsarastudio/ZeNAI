import {
  Component,
  ElementRef,
  OnDestroy,
  AfterViewInit,
  ViewChild,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { BoothConfigService } from '../../services/booth-config.service';
import {
  PHYSICAL_PHOTO_CROP_DEFAULT,
  type PhysicalPhotoCrop,
  clampPhysicalCrop,
  computeRotatedCrop,
} from '../../models/physical-frame-layout';

@Component({
  selector: 'pb-frame-adjust-dialog',
  templateUrl: './frame-adjust-dialog.component.html',
  styleUrl: './frame-adjust-dialog.component.scss',
})
export class FrameAdjustDialogComponent implements OnDestroy, AfterViewInit {
  private readonly booth = inject(BoothConfigService);
  readonly copy = this.booth.copy;

  readonly imagePath = input.required<string>();
  readonly frameFile = input.required<string>();
  readonly busy = input(false);
  readonly confirmLabel = input<string | null>(null);

  readonly confirmed = output<PhysicalPhotoCrop>();
  readonly cancelled = output<void>();

  @ViewChild('sheetCanvas') sheetCanvas?: ElementRef<HTMLCanvasElement>;

  readonly zoom = signal(PHYSICAL_PHOTO_CROP_DEFAULT.zoom);
  readonly panX = signal(PHYSICAL_PHOTO_CROP_DEFAULT.panX);
  readonly panY = signal(PHYSICAL_PHOTO_CROP_DEFAULT.panY);
  readonly err = signal<string | null>(null);
  readonly ready = signal(false);

  private photo: HTMLImageElement | null = null;
  private frame: HTMLImageElement | null = null;
  private hole = { left: 0, top: 0, width: 1, height: 1 };
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private loadGen = 0;
  private resizeObs?: ResizeObserver;

  constructor() {
    effect(() => {
      const path = this.imagePath();
      const frame = this.frameFile();
      void this.load(path, frame);
    });
    effect(() => {
      this.zoom();
      this.panX();
      this.panY();
      this.ready();
      this.draw();
    });
  }

  ngAfterViewInit(): void {
    const stage = this.sheetCanvas?.nativeElement?.parentElement;
    if (stage && typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.draw());
      this.resizeObs.observe(stage);
    }
    this.draw();
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
    this.loadGen += 1;
    this.photo = null;
    this.frame = null;
  }

  crop(): PhysicalPhotoCrop {
    return clampPhysicalCrop({ zoom: this.zoom(), panX: this.panX(), panY: this.panY() });
  }

  zoomBy(delta: number): void {
    this.zoom.set(Math.min(4, Math.max(1, Math.round((this.zoom() + delta) * 20) / 20)));
  }

  onZoomInput(ev: Event): void {
    const v = Number((ev.target as HTMLInputElement).value);
    if (Number.isFinite(v)) this.zoom.set(Math.min(4, Math.max(1, v)));
  }

  onPointerDown(ev: PointerEvent): void {
    if (this.busy()) return;
    const canvas = this.sheetCanvas?.nativeElement;
    if (!canvas) return;
    canvas.setPointerCapture(ev.pointerId);
    this.dragging = true;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
  }

  onPointerMove(ev: PointerEvent): void {
    if (!this.dragging || this.busy()) return;
    const dx = ev.clientX - this.lastX;
    const dy = ev.clientY - this.lastY;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
    const canvas = this.sheetCanvas?.nativeElement;
    if (!canvas) return;
    const z = this.zoom();
    const span = Math.max(80, Math.min(canvas.clientWidth, canvas.clientHeight) * 0.35 * z);
    this.panX.set(Math.min(1, Math.max(-1, this.panX() - dx / span)));
    this.panY.set(Math.min(1, Math.max(-1, this.panY() - dy / span)));
  }

  onPointerUp(ev: PointerEvent): void {
    const canvas = this.sheetCanvas?.nativeElement;
    if (canvas?.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    this.dragging = false;
  }

  confirm(): void {
    if (this.busy() || !this.ready()) return;
    this.confirmed.emit(this.crop());
  }

  cancel(): void {
    if (this.busy()) return;
    this.cancelled.emit();
  }

  private async load(filePath: string, frameFile: string): Promise<void> {
    const gen = ++this.loadGen;
    this.ready.set(false);
    this.err.set(null);
    this.zoom.set(1);
    this.panX.set(0);
    this.panY.set(0);
    this.photo = null;
    this.frame = null;
    if (!filePath || !frameFile || !window.pbApi?.readFileBase64 || !window.pbApi.listPhotoFrames) {
      this.err.set('Preview needs Electron.');
      return;
    }
    try {
      const listed = await window.pbApi.listPhotoFrames();
      const item = listed.frames?.find((f) => f.filename === frameFile);
      if (!item?.url) {
        this.err.set('Frame not found.');
        return;
      }
      const photoUrl = await window.pbApi.readFileBase64(filePath);
      if (gen !== this.loadGen) return;
      const [photo, frame] = await Promise.all([this.loadImg(photoUrl), this.loadImg(item.url)]);
      if (gen !== this.loadGen) return;
      this.photo = photo;
      this.frame = frame;
      this.hole = this.findHole(frame);
      this.ready.set(true);
      queueMicrotask(() => this.draw());
    } catch (e) {
      if (gen !== this.loadGen) return;
      this.err.set(String(e));
    }
  }

  private loadImg(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image.'));
      img.src = src;
    });
  }

  /** Inner photo opening. Prefer a solid transparent band; do not flood through lacy art. */
  private findHole(img: HTMLImageElement): { left: number; top: number; width: number; height: number } {
    const maxW = 720;
    const scale = Math.min(1, maxW / Math.max(1, img.naturalWidth));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const fallback = {
      left: img.naturalWidth * 0.08,
      top: img.naturalHeight * 0.08,
      width: img.naturalWidth * 0.84,
      height: img.naturalHeight * 0.84,
    };
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const trans = (x: number, y: number) => data[(y * w + x) * 4 + 3] < 16;

    const rowOpen = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) if (trans(x, y)) n += 1;
      rowOpen[y] = n / w > 0.55 ? 1 : 0;
    }
    let bestY0 = 0;
    let bestYLen = 0;
    let run = 0;
    let runStart = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && rowOpen[y]) {
        if (run === 0) runStart = y;
        run += 1;
      } else if (run > bestYLen) {
        bestY0 = runStart;
        bestYLen = run;
        run = 0;
      } else {
        run = 0;
      }
    }
    if (bestYLen < h * 0.2) return fallback;

    const y0 = bestY0;
    const y1 = bestY0 + bestYLen - 1;
    const span = y1 - y0 + 1;
    const colOpen = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let y = y0; y <= y1; y++) if (trans(x, y)) n += 1;
      colOpen[x] = n / span > 0.55 ? 1 : 0;
    }
    let bestX0 = 0;
    let bestXLen = 0;
    run = 0;
    runStart = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && colOpen[x]) {
        if (run === 0) runStart = x;
        run += 1;
      } else if (run > bestXLen) {
        bestX0 = runStart;
        bestXLen = run;
        run = 0;
      } else {
        run = 0;
      }
    }
    if (bestXLen < w * 0.25) return fallback;

    const inv = 1 / scale;
    return {
      left: bestX0 * inv,
      top: y0 * inv,
      width: bestXLen * inv,
      height: bestYLen * inv,
    };
  }

  private draw(): void {
    const canvas = this.sheetCanvas?.nativeElement;
    const photo = this.photo;
    const frame = this.frame;
    if (!canvas || !photo || !frame || !this.ready()) return;
    const fw = frame.naturalWidth;
    const fh = frame.naturalHeight;
    const parent = canvas.parentElement;
    const padX = 8;
    const padY = 8;
    const availW = Math.max(80, (parent?.clientWidth || 720) - padX);
    const availH = Math.max(80, (parent?.clientHeight || 0) - padY);
    const ar = fh / Math.max(1, fw);
    let cssW = Math.min(720, availW);
    let cssH = cssW * ar;
    if (availH > 40 && cssH > availH) {
      cssH = availH;
      cssW = cssH / ar;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, cssW, cssH);

    const sx = (this.hole.left / fw) * cssW;
    const sy = (this.hole.top / fh) * cssH;
    const sw = (this.hole.width / fw) * cssW;
    const sh = (this.hole.height / fh) * cssH;
    const box = computeRotatedCrop(photo.naturalWidth, photo.naturalHeight, sw, sh, this.crop());
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.clip();
    ctx.drawImage(photo, box.left, box.top, box.width, box.height, sx, sy, sw, sh);
    ctx.restore();
    // Same as apply: overlay PNG with its own alpha. Even-odd clip ate lacy frames.
    ctx.drawImage(frame, 0, 0, cssW, cssH);
  }
}
