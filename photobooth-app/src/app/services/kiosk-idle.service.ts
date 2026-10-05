import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { BoothConfigService } from './booth-config.service';
import { GuestSessionService } from './guest-session.service';

/** Paths where idle timeout + corner home-reset apply (not attract/admin/thanks). */
const IDLE_PATHS = new Set(['/cans', '/details', '/capture', '/review', '/preview']);

const HOME_TAP_COUNT = 4;
const HOME_TAP_WINDOW_MS = 2000;

@Injectable({ providedIn: 'root' })
export class KioskIdleService implements OnDestroy {
  private readonly router = inject(Router);
  private readonly booth = inject(BoothConfigService);
  private readonly session = inject(GuestSessionService);

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private routeSub: Subscription | null = null;
  private activityBound = false;
  private currentPath = '';
  private homeTapCount = 0;
  private homeTapResetTimer: ReturnType<typeof setTimeout> | null = null;

  /** Visible only on idle-watched guest screens (top-right secret reset). */
  readonly homeHotspotVisible = signal(false);

  start(): void {
    if (this.routeSub) return;
    this.currentPath = this.normalizePath(this.router.url);
    this.syncForRoute();
    this.routeSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.currentPath = this.normalizePath(e.urlAfterRedirects || e.url);
        this.syncForRoute();
      });
  }

  ngOnDestroy(): void {
    this.stop();
  }

  stop(): void {
    this.clearIdleTimer();
    this.clearHomeTapTimers();
    this.unbindActivity();
    this.routeSub?.unsubscribe();
    this.routeSub = null;
    this.homeHotspotVisible.set(false);
  }

  /** 4 taps in the top-right corner → attract. */
  onHomeCornerTap(): void {
    if (!this.isIdlePath(this.currentPath)) return;
    this.bumpActivity();
    this.homeTapCount += 1;
    if (this.homeTapResetTimer) clearTimeout(this.homeTapResetTimer);
    this.homeTapResetTimer = setTimeout(() => {
      this.homeTapCount = 0;
      this.homeTapResetTimer = null;
    }, HOME_TAP_WINDOW_MS);

    if (this.homeTapCount >= HOME_TAP_COUNT) {
      this.homeTapCount = 0;
      this.clearHomeTapTimers();
      this.goHome();
    }
  }

  private syncForRoute(): void {
    const active = this.isIdlePath(this.currentPath);
    this.homeHotspotVisible.set(active);
    if (!active) {
      this.clearIdleTimer();
      this.unbindActivity();
      this.homeTapCount = 0;
      this.clearHomeTapTimers();
      return;
    }
    this.bindActivity();
    this.resetIdleTimer();
  }

  private bindActivity(): void {
    if (this.activityBound || typeof window === 'undefined') return;
    window.addEventListener('pointerdown', this.onActivity, { capture: true });
    window.addEventListener('keydown', this.onActivity, { capture: true });
    window.addEventListener('touchstart', this.onActivity, { capture: true, passive: true });
    this.activityBound = true;
  }

  private unbindActivity(): void {
    if (!this.activityBound || typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', this.onActivity, { capture: true } as EventListenerOptions);
    window.removeEventListener('keydown', this.onActivity, { capture: true } as EventListenerOptions);
    window.removeEventListener('touchstart', this.onActivity, { capture: true } as EventListenerOptions);
    this.activityBound = false;
  }

  private readonly onActivity = (): void => {
    this.bumpActivity();
  };

  private bumpActivity(): void {
    if (!this.isIdlePath(this.currentPath)) return;
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    const seconds = Number(this.booth.kiosk().idleTimeoutSeconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.goHome();
    }, Math.round(seconds * 1000));
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearHomeTapTimers(): void {
    if (this.homeTapResetTimer) {
      clearTimeout(this.homeTapResetTimer);
      this.homeTapResetTimer = null;
    }
  }

  private goHome(): void {
    this.clearIdleTimer();
    this.session.clear();
    void this.router.navigateByUrl('/');
  }

  private isIdlePath(path: string): boolean {
    return IDLE_PATHS.has(path);
  }

  private normalizePath(url: string): string {
    const bare = String(url || '')
      .split('?')[0]
      .split('#')[0]
      .replace(/\/+$/, '');
    return bare === '' ? '/' : bare.startsWith('/') ? bare : `/${bare}`;
  }
}
