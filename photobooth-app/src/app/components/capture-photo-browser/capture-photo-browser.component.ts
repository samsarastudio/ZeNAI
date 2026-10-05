import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { BoothConfigService } from '../../services/booth-config.service';
import { GalleryUploadService } from '../../services/gallery-upload.service';
import type { PbCaptureHistoryItem } from '../../../types/pb-api';
import { PrintTroubleDialogComponent } from '../print-trouble-dialog/print-trouble-dialog.component';

export type CaptureWhenFilter = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'custom';

@Component({
  selector: 'pb-capture-photo-browser',
  imports: [DatePipe, PrintTroubleDialogComponent],
  templateUrl: './capture-photo-browser.component.html',
  styleUrl: './capture-photo-browser.component.scss',
  host: {
    class: 'pb-capture-browser',
    '[class.is-compact]': 'compact()',
  },
})
export class CapturePhotoBrowserComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly galleryUpload = inject(GalleryUploadService);
  readonly copy = this.booth.copy;

  readonly compact = input(false);
  readonly showPrint = input(true);
  readonly pageSize = input(24);

  readonly photos = signal<PbCaptureHistoryItem[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly thumbUrls = signal<Record<string, string>>({});
  readonly previewUrls = signal<Record<string, string>>({});
  readonly previewUrl = signal<string | null>(null);
  readonly err = signal<string | null>(null);
  readonly loading = signal(true);

  readonly whenFilter = signal<CaptureWhenFilter>('all');
  readonly customFrom = signal('');
  readonly customTo = signal('');
  readonly page = signal(1);

  readonly printBusy = signal(false);
  readonly printDone = signal(false);
  readonly printErr = signal<string | null>(null);
  readonly deleteBusy = signal(false);
  readonly confirmDelete = signal(false);

  readonly selected = computed(() => {
    const id = this.selectedId();
    return this.photos().find((p) => p.id === id) ?? null;
  });

  readonly printEnabled = computed(
    () => this.showPrint() && this.booth.print().enabled === true,
  );

  readonly filtered = computed(() => {
    const when = this.whenFilter();
    const fromMs = this.rangeStartMs(when);
    const toMs = this.rangeEndMs(when);
    return this.photos().filter((p) => {
      const t = Date.parse(p.capturedAt);
      if (!Number.isFinite(t)) return true;
      if (fromMs != null && t < fromMs) return false;
      if (toMs != null && t > toMs) return false;
      return true;
    });
  });

  readonly pageCount = computed(() => {
    const n = this.filtered().length;
    const size = Math.max(1, this.pageSize());
    return Math.max(1, Math.ceil(n / size));
  });

  readonly pageItems = computed(() => {
    const size = Math.max(1, this.pageSize());
    const p = Math.min(this.page(), this.pageCount());
    const start = (p - 1) * size;
    return this.filtered().slice(start, start + size);
  });

  readonly canPrint = computed(
    () => this.printEnabled() && !!this.selected() && !this.printBusy() && !this.printDone(),
  );

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    if (!window.pbApi?.listCaptureHistory) {
      this.err.set('Photo history requires Electron.');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.err.set(null);
    try {
      const r = await window.pbApi.listCaptureHistory({ limit: 2000 });
      if (!r.ok) {
        this.err.set(r.error || 'Could not load photos.');
        this.photos.set([]);
        return;
      }
      const list = r.photos ?? [];
      this.photos.set(list);
      this.page.set(1);
      await this.ensureThumbs(this.pageItems());
      const keep = list.find((p) => p.id === this.selectedId());
      if (keep) {
        this.selectedId.set(keep.id);
        await this.ensurePreview(keep);
      } else if (this.pageItems()[0]) {
        await this.selectPhoto(this.pageItems()[0]);
      } else {
        this.selectedId.set(null);
        this.previewUrl.set(null);
      }
    } catch (e) {
      this.err.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  setWhen(when: CaptureWhenFilter): void {
    this.whenFilter.set(when);
    this.page.set(1);
    void this.afterFilterChange();
  }

  onCustomFrom(ev: Event): void {
    this.customFrom.set((ev.target as HTMLInputElement).value);
    if (this.whenFilter() === 'custom') {
      this.page.set(1);
      void this.afterFilterChange();
    }
  }

  onCustomTo(ev: Event): void {
    this.customTo.set((ev.target as HTMLInputElement).value);
    if (this.whenFilter() === 'custom') {
      this.page.set(1);
      void this.afterFilterChange();
    }
  }

  goPage(delta: number): void {
    const next = Math.min(this.pageCount(), Math.max(1, this.page() + delta));
    this.page.set(next);
    const first = this.pageItems()[0];
    void this.ensureThumbs(this.pageItems());
    if (first) void this.selectPhoto(first);
  }

  async selectPhoto(photo: PbCaptureHistoryItem): Promise<void> {
    this.selectedId.set(photo.id);
    this.printDone.set(false);
    this.printErr.set(null);
    this.confirmDelete.set(false);
    void this.ensureThumbs([photo]);
    await this.ensurePreview(photo);
  }

  thumbKey(photo: PbCaptureHistoryItem): string {
    return `${this.viewPath(photo)}:${photo.capturedAt}`;
  }

  sourceOriginal(photo: PbCaptureHistoryItem): string {
    if (photo.originalPath) return photo.originalPath;
    const p = photo.displayPath || photo.printPath || '';
    return p
      .replace(/_physical\.png$/i, '.jpg')
      .replace(/_ai\.png$/i, '.jpg')
      .replace(/_framed\.png$/i, '.jpg');
  }

  viewPath(photo: PbCaptureHistoryItem): string {
    return photo.displayPath;
  }

  viewLabel(photo: PbCaptureHistoryItem): string {
    return photo.label;
  }

  private async afterFilterChange(): Promise<void> {
    const sel = this.selected();
    if (sel && this.filtered().some((p) => p.id === sel.id)) {
      const idx = this.filtered().findIndex((p) => p.id === sel.id);
      const size = Math.max(1, this.pageSize());
      this.page.set(Math.floor(idx / size) + 1);
    }
    await this.ensureThumbs(this.pageItems());
    const items = this.pageItems();
    if (sel && this.filtered().some((p) => p.id === sel.id)) {
      await this.ensurePreview(sel);
      return;
    }
    if (items[0]) {
      await this.selectPhoto(items[0]);
      return;
    }
    this.selectedId.set(null);
    this.previewUrl.set(null);
  }

  async printOnce(): Promise<void> {
    const photo = this.selected();
    if (!photo || !this.canPrint() || !window.pbApi?.printPhoto) {
      this.printErr.set('Printing requires Electron.');
      return;
    }
    this.printBusy.set(true);
    try {
      const r = await window.pbApi.printPhoto({
        filePath: this.viewPath(photo),
        deviceName: this.booth.print().printerName || undefined,
        layoutMode: photo.layoutMode,
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

  askDelete(): void {
    if (!this.selected()) return;
    this.confirmDelete.set(true);
  }

  async confirmDeleteNow(): Promise<void> {
    const photo = this.selected();
    if (!photo || !window.pbApi?.deleteCaptureHistory) {
      this.err.set('Delete requires Electron.');
      this.confirmDelete.set(false);
      return;
    }
    this.deleteBusy.set(true);
    try {
      const r = await window.pbApi.deleteCaptureHistory(photo.id);
      if (!r.ok) {
        this.err.set(r.error || 'Could not delete photo.');
        return;
      }
      this.confirmDelete.set(false);
      this.selectedId.set(null);
      this.previewUrl.set(null);
      await this.reload();
    } catch (e) {
      this.err.set(String(e));
    } finally {
      this.deleteBusy.set(false);
    }
  }

  private async ensureThumbs(items: PbCaptureHistoryItem[]): Promise<void> {
    if (!window.pbApi) return;
    const thumbs = { ...this.thumbUrls() };
    let changed = false;
    for (const photo of items) {
      const key = this.thumbKey(photo);
      if (thumbs[key]) continue;
      try {
        const filePath = this.viewPath(photo);
        thumbs[key] = window.pbApi.readFileThumbBase64
          ? await window.pbApi.readFileThumbBase64(filePath, 240)
          : await window.pbApi.readFileBase64(filePath);
        changed = true;
      } catch {
        /* thumb optional */
      }
    }
    if (changed) this.thumbUrls.set(thumbs);
  }

  private async ensurePreview(photo: PbCaptureHistoryItem): Promise<void> {
    const key = this.thumbKey(photo);
    const cached = this.previewUrls()[key];
    if (cached) {
      this.previewUrl.set(cached);
      return;
    }
    if (!window.pbApi) return;
    try {
      const filePath = this.viewPath(photo);
      const url = window.pbApi.readFileThumbBase64
        ? await window.pbApi.readFileThumbBase64(filePath, 1100)
        : await window.pbApi.readFileBase64(filePath);
      this.previewUrls.update((m) => ({ ...m, [key]: url }));
      if (this.selectedId() === photo.id) this.previewUrl.set(url);
    } catch {
      if (this.selectedId() === photo.id) this.previewUrl.set(this.thumbUrls()[key] ?? null);
    }
  }

  private rangeStartMs(when: CaptureWhenFilter): number | null {
    const now = new Date();
    if (when === 'all') return null;
    if (when === 'today') return this.startOfDay(now);
    if (when === 'yesterday') return this.startOfDay(new Date(now.getTime() - 86400000));
    if (when === 'week') return this.startOfDay(new Date(now.getTime() - 6 * 86400000));
    if (when === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    if (when === 'custom') {
      const from = this.customFrom();
      if (!from) return null;
      const d = new Date(`${from}T00:00:00`);
      return Number.isFinite(d.getTime()) ? d.getTime() : null;
    }
    return null;
  }

  private rangeEndMs(when: CaptureWhenFilter): number | null {
    const now = new Date();
    if (when === 'all' || when === 'week' || when === 'month' || when === 'today') return null;
    if (when === 'yesterday') return this.startOfDay(now) - 1;
    if (when === 'custom') {
      const to = this.customTo();
      if (!to) return null;
      const d = new Date(`${to}T23:59:59.999`);
      return Number.isFinite(d.getTime()) ? d.getTime() : null;
    }
    return null;
  }

  private startOfDay(d: Date): number {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
}
