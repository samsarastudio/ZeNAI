import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BoothConfigService } from '../../services/booth-config.service';
import { GuestSessionService } from '../../services/guest-session.service';
import { BrandingLogoService } from '../../services/branding-logo.service';

/** Zip prototype order: Citrus → Spearmint → Chill → Arctic Mint → Cinnamon → Peppermint */
const CAN_LIDS: Record<string, string> = {
  citrus: 'zyn/cans/citrus.png',
  spearmint: 'zyn/cans/spearmint.png',
  wintergreen: 'zyn/cans/chill.png',
  'cool-mint': 'zyn/cans/arctic-mint.png',
  cinnamon: 'zyn/cans/cinnamon.png',
  peppermint: 'zyn/cans/peppermint.png',
};

const CAN_ORDER = ['citrus', 'spearmint', 'wintergreen', 'cool-mint', 'cinnamon', 'peppermint'];

const CAN_DISPLAY: Record<string, string> = {
  citrus: 'CITRUS',
  spearmint: 'SPEARMINT',
  wintergreen: 'CHILL',
  'cool-mint': 'ARCTIC MINT',
  cinnamon: 'CINNAMON',
  peppermint: 'PEPPERMINT',
};

/** Enough repeats that a guest never hits either end — no snap/recenter. */
const LOOP_COPIES = 41;

type FlavorItem = {
  id: string;
  displayLabel: string;
  label: string;
};

@Component({
  selector: 'pb-can-select-page',
  imports: [],
  templateUrl: './can-select-page.component.html',
  styleUrl: './can-select-page.component.scss',
})
export class CanSelectPageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly session = inject(GuestSessionService);
  private readonly router = inject(Router);
  readonly branding = inject(BrandingLogoService);
  readonly copy = this.booth.copy;

  /** Logical selected index 0..n-1 (dots / session). */
  readonly focusIndex = signal(0);
  /** Absolute slide on the long repeating strip — only ever moves ±1 (or short jump). */
  readonly trackIndex = signal(0);
  readonly animating = signal(false);
  /** Enable slide transition only after first paint (avoids animating into place). */
  readonly trackReady = signal(false);

  readonly flavors = computed((): FlavorItem[] => {
    const byId = new Map(this.booth.cans().map((c) => [c.id, c]));
    return CAN_ORDER.map((id) => {
      const c = byId.get(id);
      if (!c || !CAN_LIDS[id]) return null;
      return {
        id: c.id,
        label: c.label,
        displayLabel: CAN_DISPLAY[id] || c.label,
      };
    }).filter((c): c is FlavorItem => !!c);
  });

  /** Same set of lids repeated — scroll forever in either direction. */
  readonly loopFlavors = computed(() => {
    const list = this.flavors();
    const out: FlavorItem[] = [];
    for (let i = 0; i < LOOP_COPIES; i++) out.push(...list);
    return out;
  });

  readonly selectedId = computed(() => this.flavors()[this.focusIndex()]?.id ?? null);

  ngOnInit(): void {
    this.session.email.set('');
    this.session.firstName.set('');
    this.session.lastName.set('');
    this.session.setCapturePath(null);
    const list = this.flavors();
    const n = list.length;
    const current = this.session.canId();
    const idx = current ? list.findIndex((c) => c.id === current) : -1;
    const start = idx >= 0 ? idx : Math.min(3, Math.max(0, n - 1));
    this.focusIndex.set(start);
    // Start in the middle of the strip so both directions feel infinite
    const midCopy = Math.floor(LOOP_COPIES / 2);
    this.trackIndex.set(midCopy * n + start);
    this.syncSession();
    // Next frames: layout is correct with translateX only, then enable transitions
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.trackReady.set(true));
    });
  }

  artFor(id: string): string {
    return CAN_LIDS[id] ?? '';
  }

  trackTransform(): string {
    return `translate3d(calc(-1 * ${this.trackIndex()} * var(--slide-step)), 0, 0)`;
  }

  prev(): void {
    this.step(-1);
  }

  next(): void {
    this.step(1);
  }

  goTo(index: number): void {
    const n = this.flavors().length;
    if (index < 0 || index >= n || this.animating()) return;
    const cur = this.focusIndex();
    if (index === cur) return;
    let delta = index - cur;
    if (delta > n / 2) delta -= n;
    if (delta < -n / 2) delta += n;
    this.step(delta);
  }

  selectAtTrack(loopIndex: number): void {
    const n = this.flavors().length;
    if (!n || this.animating()) return;
    const delta = loopIndex - this.trackIndex();
    if (delta === 0) return;
    this.step(delta);
  }

  onTrackTransitionEnd(ev: TransitionEvent): void {
    if (ev.propertyName !== 'transform') return;
    // Only the track itself — ignore bubbled events
    if ((ev.target as HTMLElement | null)?.classList?.contains('pb-zyn-carousel-track') !== true) {
      return;
    }
    this.animating.set(false);
  }

  private step(delta: number): void {
    const n = this.flavors().length;
    if (!n || !delta || this.animating()) return;
    this.animating.set(true);
    this.trackIndex.update((i) => i + delta);
    this.focusIndex.set((((this.focusIndex() + delta) % n) + n) % n);
    this.syncSession();
  }

  private syncSession(): void {
    const f = this.flavors()[this.focusIndex()];
    if (f) this.session.selectCan(f.id, f.displayLabel);
  }

  async continue(): Promise<void> {
    const f = this.flavors()[this.focusIndex()];
    if (!f) return;
    this.session.selectCan(f.id, f.displayLabel);
    await this.router.navigate(['/capture']);
  }
}
