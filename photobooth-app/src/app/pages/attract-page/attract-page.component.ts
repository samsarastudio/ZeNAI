import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrandingLogoService } from '../../services/branding-logo.service';
import { BoothConfigService } from '../../services/booth-config.service';
import { GuestSessionService } from '../../services/guest-session.service';
import { PrintHistoryPanelComponent } from '../../components/print-history-panel/print-history-panel.component';

@Component({
  selector: 'pb-attract-page',
  imports: [RouterLink, PrintHistoryPanelComponent],
  templateUrl: './attract-page.component.html',
  styleUrl: './attract-page.component.scss',
})
export class AttractPageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly session = inject(GuestSessionService);
  readonly branding = inject(BrandingLogoService);
  readonly copy = this.booth.copy;
  readonly historyOpen = signal(false);

  /** Guest picks a ZYN can after Tap to start. */
  readonly startLink = '/cans';

  readonly apiKeyMissing = computed(() => !this.booth.openAiConfigured());

  ngOnInit(): void {
    this.session.clear();
  }

  openHistory(): void {
    this.historyOpen.set(true);
  }

  closeHistory(): void {
    this.historyOpen.set(false);
  }
}
