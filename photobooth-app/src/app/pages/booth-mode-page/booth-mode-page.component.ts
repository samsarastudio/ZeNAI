import { Component, OnInit, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BrandingLogoService } from '../../services/branding-logo.service';
import { BoothConfigService } from '../../services/booth-config.service';
import { BoothModeService } from '../../services/booth-mode.service';
import { AiStyleService } from '../../services/ai-style.service';
import type { PhotoboothBoothModeId } from '../../models/photobooth-config.model';

@Component({
  selector: 'pb-booth-mode-page',
  imports: [RouterLink],
  templateUrl: './booth-mode-page.component.html',
  styleUrl: './booth-mode-page.component.scss',
})
export class BoothModePageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly boothMode = inject(BoothModeService);
  private readonly aiStyle = inject(AiStyleService);
  private readonly router = inject(Router);
  readonly branding = inject(BrandingLogoService);

  readonly copy = this.booth.copy;
  readonly offered = this.booth.offeredBoothModes;

  readonly showDefault = computed(() => this.offered().includes('default'));
  readonly showPhysical = computed(() => this.offered().includes('physicalFrame'));

  ngOnInit(): void {
    const modes = this.offered();
    if (modes.length <= 1) {
      this.boothMode.selectMode(modes[0] || 'default');
      void this.continueAfterMode();
    }
  }

  choose(id: PhotoboothBoothModeId): void {
    this.boothMode.selectMode(id);
    void this.continueAfterMode();
  }

  private async continueAfterMode(): Promise<void> {
    if (this.booth.requireQrUnlock()) {
      await this.router.navigate(['/qr']);
      return;
    }
    if (this.boothMode.isPhysicalFrameMode()) {
      this.aiStyle.clear();
      await this.router.navigate(['/capture']);
      return;
    }
    const fixed = this.booth.fixedAiModeId();
    if (fixed) {
      this.aiStyle.selectMode(fixed);
      await this.router.navigate(['/capture']);
      return;
    }
    if (this.booth.shouldShowAiModeStep()) {
      await this.router.navigate(['/ai-mode']);
      return;
    }
    await this.router.navigate(['/capture']);
  }
}
