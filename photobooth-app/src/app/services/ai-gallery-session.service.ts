import { Injectable, computed, signal } from '@angular/core';

/** Holds paired paths after AI generation so the gallery page can show originals + AI output. */
@Injectable({ providedIn: 'root' })
export class AiGallerySessionService {
  readonly originalPath = signal<string | null>(null);
  readonly aiPath = signal<string | null>(null);

  readonly hasPair = computed(() => {
    const a = this.originalPath();
    const b = this.aiPath();
    return typeof a === 'string' && a.length > 0 && typeof b === 'string' && b.length > 0;
  });

  setPair(originalPath: string, aiPath: string): void {
    this.originalPath.set(originalPath);
    this.aiPath.set(aiPath);
  }

  clear(): void {
    this.originalPath.set(null);
    this.aiPath.set(null);
  }
}
