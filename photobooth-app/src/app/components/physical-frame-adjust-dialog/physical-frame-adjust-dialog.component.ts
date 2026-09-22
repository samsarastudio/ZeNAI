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
  autoPhysicalSheetMm,
  clampPhysicalCrop,
  computeRotatedCrop,
} from '../../models/physical-frame-layout';

@Component({
  selector: 'pb-physical-frame-adjust-dialog',
  templateUrl: './physical-frame-adjust-dialog.component.html',
  styleUrl: './physical-frame-adjust-dialog.component.scss',
})
export class PhysicalFrameAdjustDialogComponent implements OnDestroy, AfterViewInit {
  private readonly booth = inject(BoothConfigService);
  readonly copy = this.booth.copy;

  readonly imagePath = input.required<string>();
  readonly busy = input(false);

  readonly confirmed = output<PhysicalPhotoCrop>();
  readonly cancelled = output<void>();

  @ViewChild('sheetCanvas') sheetCanvas?: ElementRef<HTMLCanvasElement>;

  readonly zoom = signal(PHYSICAL_PHOTO_CROP_DEFAULT.zoom);
  readonly panX = signal(PHYSICAL_PHOTO_CROP_DEFAULT.panX);
  readonly panY = signal(PHYSICAL_PHOTO_CROP_DEFAULT.panY);
  readonly err = signal<string | null>(null);
  readonly ready = signal(false);

  private img: HTMLImageElement | null = null;
  private rotated: HTMLCanvasElement | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private loadGen = 0;

  constructor() {
    effect(() => {
      const path = this.imagePath();
      void this.loadImage(path);
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
    this.draw();
  }

  ngOnDestroy(): void {
    this.loadGen += 1;
    this.img = null;
    this.rotated = null;
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

  private async loadImage(filePath: string): Promise<void> {
    const gen = ++this.loadGen;
    this.ready.set(false);
    this.err.set(null);
    this.zoom.set(1);
    this.panX.set(0);
    this.panY.set(0);
    if (!filePath || !window.pbApi?.readFileBase64) {
      this.err.set('Preview needs Electron.');
      return;
    }
    try {
      const url = await window.pbApi.readFileBase64(filePath);
      if (gen !== this.loadGen) return;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not load photo.'));
        img.src = url;
      });
      if (gen !== this.loadGen) return;
      this.img = img;
      this.rotated = this.makeRotated(img);
      this.ready.set(true);
      queueMicrotask(() => this.draw());
    } catch (e) {
      if (gen !== this.loadGen) return;
      this.err.set(String(e));
    }
  }

  private makeRotated(img: HTMLImageElement): HTMLCanvasElement {
    const rot = this.booth.physicalFrame().rotateDegrees === 90 ? 90 : -90;
    const c = document.createElement('canvas');
    const maxSide = 1600;
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    c.width = h;
    c.height = w;
    const ctx = c.getContext('2d');
    if (!ctx) return c;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return c;
  }

  private draw(): void {
    const canvas = this.sheetCanvas?.nativeElement;
    const rotated = this.rotated;
    if (!canvas || !rotated || !this.ready()) return;
    const pf = this.booth.physicalFrame();
    const layout = autoPhysicalSheetMm(pf.cellWidthCm, pf.cellHeightCm);
    const cssW = Math.min(720, canvas.parentElement?.clientWidth || 720);
    const scale = cssW / layout.pageWmm;
    const cssH = layout.pageHmm * scale;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cssW, cssH);

    const cellW = layout.cellWmm * scale;
    const cellH = layout.cellHmm * scale;
    const gap = layout.gapMm * scale;
    const mx = layout.marginXMm * scale;
    const my = layout.marginYMm * scale;
    const pad = (pf.innerPaddingMm / 10) * scale;
    const sL = (pf.safeInsetLeftMm / 10) * scale;
    const sR = (pf.safeInsetRightMm / 10) * scale;
    const sT = (pf.safeInsetTopMm / 10) * scale;
    const sB = (pf.safeInsetBottomMm / 10) * scale;

    const crop = this.crop();
    this.drawCell(ctx, rotated, mx, my, cellW, cellH, pad, sL, sR, sT, sB, crop, pf.borderEnabled);
    this.drawCell(
      ctx,
      rotated,
      mx + cellW + gap,
      my,
      cellW,
      cellH,
      pad,
      sL,
      sR,
      sT,
      sB,
      crop,
      pf.borderEnabled,
    );
  }

  private drawCell(
    ctx: CanvasRenderingContext2D,
    rotated: HTMLCanvasElement,
    x: number,
    y: number,
    cellW: number,
    cellH: number,
    pad: number,
    sL: number,
    sR: number,
    sT: number,
    sB: number,
    crop: PhysicalPhotoCrop,
    border: boolean,
  ): void {
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, cellW, cellH);
    const frameW = Math.max(8, cellW - pad * 2);
    const frameH = Math.max(8, cellH - pad * 2);
    const safeW = Math.max(8, frameW - sL - sR);
    const safeH = Math.max(8, frameH - sT - sB);
    const sx = x + pad + sL;
    const sy = y + pad + sT;
    const box = computeRotatedCrop(rotated.width, rotated.height, safeW, safeH, crop);
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, safeW, safeH);
    ctx.clip();
    ctx.drawImage(rotated, box.left, box.top, box.width, box.height, sx, sy, safeW, safeH);
    ctx.restore();
    if (border) {
      ctx.strokeStyle = 'rgba(139, 115, 72, 0.92)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + pad + 2, y + pad + 2, frameW - 4, frameH - 4);
      ctx.strokeStyle = 'rgba(220, 201, 163, 0.78)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + pad + 6, y + pad + 6, frameW - 12, frameH - 12);
    }
  }
}
