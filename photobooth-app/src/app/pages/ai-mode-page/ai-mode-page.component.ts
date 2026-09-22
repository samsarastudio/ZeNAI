import { Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BrandingLogoService } from '../../services/branding-logo.service';
import { BoothConfigService } from '../../services/booth-config.service';
import { AiStyleService } from '../../services/ai-style.service';
import { PLAIN_PHOTO_MODE_ID } from '../../models/photobooth-config.model';

@Component({
  selector: 'pb-ai-mode-page',
  imports: [RouterLink],
  templateUrl: './ai-mode-page.component.html',
  styleUrl: './ai-mode-page.component.scss',
})
export class AiModePageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly router = inject(Router);
  private readonly aiStyle = inject(AiStyleService);
  readonly branding = inject(BrandingLogoService);

  readonly copy = this.booth.copy;
  readonly modes = this.booth.aiModes;
  readonly plainModeId = PLAIN_PHOTO_MODE_ID;

  ngOnInit(): void {
    const fixed = this.booth.fixedAiModeId();
    if (fixed) {
      this.aiStyle.selectMode(fixed);
      void this.router.navigate(['/capture']);
      return;
    }
    if (!this.booth.aiGenerationEnabled()) {
      void this.router.navigate(['/capture']);
    }
  }

  choose(id: string): void {
    this.aiStyle.selectMode(id);
    void this.router.navigate(['/capture']);
  }
}
