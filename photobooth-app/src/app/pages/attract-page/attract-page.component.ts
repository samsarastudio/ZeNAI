import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrandingLogoService } from '../../services/branding-logo.service';
import { BoothConfigService } from '../../services/booth-config.service';
import { GuestSessionService } from '../../services/guest-session.service';
import { PrintHistoryPanelComponent } from '../../components/print-history-panel/print-history-panel.component';

const ADMIN_UNLOCK_TAPS = 3;
/** Max gap between taps; slower taps reset the count. */
const ADMIN_TAP_WINDOW_MS = 2000;
/** How long the Admin link stays visible after unlock. */
const ADMIN_LINK_VISIBLE_MS = 5 * 60 * 1000;

@Component({
  selector: 'pb-attract-page',
  imports: [RouterLink, PrintHistoryPanelComponent],
  templateUrl: './attract-page.component.html',
  styleUrl: './attract-page.component.scss',
})
export class AttractPageComponent implements OnInit, OnDestroy {
  private readonly booth = inject(BoothConfigService);
  private readonly session = inject(GuestSessionService);
  readonly branding = inject(BrandingLogoService);
  readonly copy = this.booth.copy;
  readonly historyOpen = signal(false);
  readonly adminLinkVisible = signal(false);

  private adminTapCount = 0;
  private adminTapResetTimer: ReturnType<typeof setTimeout> | null = null;
  private adminHideTimer: ReturnType<typeof setTimeout> | null = null;

  /** Guest picks a ZYN can after Tap to start. */
  readonly startLink = '/cans';

  readonly apiKeyMissing = computed(() => !this.booth.openAiConfigured());

  /** AI: exactly two lines — "WHEN PHOTO" / "MEETS FINISH" (never one word per line). */
  readonly titleLines = computed(() => {
    const raw = (this.copy().attract.title || 'WHEN PHOTO\nMEETS FINISH').trim();
    const parts = raw
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 2);
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length >= 4) {
      return [words.slice(0, 2).join(' '), words.slice(2).join(' ')];
    }
    if (words.length === 3) return [words.slice(0, 2).join(' '), words[2]];
    return words.length ? [words.join(' ')] : ['WHEN PHOTO', 'MEETS FINISH'];
  });

  ngOnInit(): void {
    this.session.clear();
  }

  ngOnDestroy(): void {
    this.clearAdminTimers();
  }

  openHistory(): void {
    this.historyOpen.set(true);
  }

  closeHistory(): void {
    this.historyOpen.set(false);
  }

  onAdminCornerTap(): void {
    if (this.adminLinkVisible()) {
      this.showAdminLink();
      return;
    }

    this.adminTapCount += 1;
    if (this.adminTapResetTimer) clearTimeout(this.adminTapResetTimer);
    this.adminTapResetTimer = setTimeout(() => {
      this.adminTapCount = 0;
      this.adminTapResetTimer = null;
    }, ADMIN_TAP_WINDOW_MS);

    if (this.adminTapCount >= ADMIN_UNLOCK_TAPS) {
      this.adminTapCount = 0;
      if (this.adminTapResetTimer) {
        clearTimeout(this.adminTapResetTimer);
        this.adminTapResetTimer = null;
      }
      this.showAdminLink();
    }
  }

  private showAdminLink(): void {
    this.adminLinkVisible.set(true);
    if (this.adminHideTimer) clearTimeout(this.adminHideTimer);
    this.adminHideTimer = setTimeout(() => {
      this.adminLinkVisible.set(false);
      this.adminHideTimer = null;
    }, ADMIN_LINK_VISIBLE_MS);
  }

  private clearAdminTimers(): void {
    if (this.adminTapResetTimer) {
      clearTimeout(this.adminTapResetTimer);
      this.adminTapResetTimer = null;
    }
    if (this.adminHideTimer) {
      clearTimeout(this.adminHideTimer);
      this.adminHideTimer = null;
    }
  }
}
