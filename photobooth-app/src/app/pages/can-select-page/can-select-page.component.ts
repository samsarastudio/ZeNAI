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
  readonly selectedId = signal<string | null>(null);
  readonly flavors = computed(() => {
    const byId = new Map(this.booth.cans().map((c) => [c.id, c]));
    return CAN_ORDER.map((id) => {
      const c = byId.get(id);
      if (!c || !CAN_LIDS[id]) return null;
      return { ...c, displayLabel: CAN_DISPLAY[id] || c.label };
    }).filter((c): c is NonNullable<typeof c> & { displayLabel: string } => !!c);
  });

  ngOnInit(): void {
    this.session.email.set('');
    this.session.firstName.set('');
    this.session.lastName.set('');
    this.session.setCapturePath(null);
    const current = this.session.canId();
    this.selectedId.set(current && CAN_LIDS[current] ? current : null);
  }

  artFor(id: string): string {
    return CAN_LIDS[id] ?? '';
  }

  select(id: string, label: string): void {
    this.selectedId.set(id);
    this.session.selectCan(id, label);
  }

  async continue(): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    const match = this.flavors().find((c) => c.id === id);
    if (!match) return;
    this.session.selectCan(match.id, match.displayLabel);
    await this.router.navigate(['/capture']);
  }
}
