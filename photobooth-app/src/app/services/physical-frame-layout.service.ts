import { Injectable, inject } from '@angular/core';
import { BoothConfigService } from './booth-config.service';
import { GalleryUploadService } from './gallery-upload.service';
import type { PhysicalPhotoCrop } from '../models/physical-frame-layout';
import { clampPhysicalCrop } from '../models/physical-frame-layout';

@Injectable({ providedIn: 'root' })
export class PhysicalFrameLayoutService {
  private readonly booth = inject(BoothConfigService);
  private readonly galleryUpload = inject(GalleryUploadService);

  async generate(
    imagePath: string,
    crop?: Partial<PhysicalPhotoCrop> | null,
    opts?: { upload?: boolean },
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!window.pbApi?.applyPhysicalFrameLayout) {
      return { ok: false, error: 'Physical layout requires Electron.' };
    }
    const pf = this.booth.physicalFrame();
    const c = clampPhysicalCrop(crop);
    const r = await window.pbApi.applyPhysicalFrameLayout({
      imagePath,
      ...pf,
      cropZoom: c.zoom,
      cropPanX: c.panX,
      cropPanY: c.panY,
    });
    if (r.ok && r.path && opts?.upload !== false) {
      this.galleryUpload.queueUpload(r.path, 'physical');
    }
    return r;
  }
}
