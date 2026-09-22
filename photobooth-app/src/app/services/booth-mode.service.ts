import { Injectable, computed, inject, signal } from '@angular/core';
import type { PhotoboothBoothModeId } from '../models/photobooth-config.model';
import { BoothConfigService } from './booth-config.service';

/**
 * Guest-selected booth experience for the current session (Default vs Physical frame).
 */
@Injectable({ providedIn: 'root' })
export class BoothModeService {
  private readonly booth = inject(BoothConfigService);

  /** Selected mode for this session, or null before pick / after clear. */
  readonly selectedModeId = signal<PhotoboothBoothModeId | null>(null);

  readonly effectiveMode = computed<PhotoboothBoothModeId>(() => {
    const selected = this.selectedModeId();
    if (selected) return selected;
    const offered = this.booth.offeredBoothModes();
    if (offered.length === 1) return offered[0];
    return 'default';
  });

  readonly isPhysicalFrameMode = computed(() => this.effectiveMode() === 'physicalFrame');

  selectMode(id: PhotoboothBoothModeId): void {
    this.selectedModeId.set(id);
  }

  clear(): void {
    this.selectedModeId.set(null);
  }
}
