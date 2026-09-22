import { Injectable, signal } from '@angular/core';

/**
 * Holds the AI mode chosen on the style screen for the current QR session.
 */
@Injectable({ providedIn: 'root' })
export class AiStyleService {
  /** Selected `PhotoboothAiMode.id`, or null before selection / after clear. */
  readonly selectedModeId = signal<string | null>(null);

  selectMode(id: string): void {
    this.selectedModeId.set(id);
  }

  clear(): void {
    this.selectedModeId.set(null);
  }
}
