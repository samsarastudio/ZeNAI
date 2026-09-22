import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';
import { BrandingLogoService } from './services/branding-logo.service';
import { BoothConfigService } from './services/booth-config.service';
import { GalleryUploadService } from './services/gallery-upload.service';
import { ThemeService } from './services/theme.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withHashLocation()),
    provideAppInitializer(() => {
      const booth = inject(BoothConfigService);
      const theme = inject(ThemeService);
      const branding = inject(BrandingLogoService);
      const gallery = inject(GalleryUploadService);
      return booth
        .load()
        .then(() => theme.applyFromConfig())
        .then(() => branding.refreshAll())
        .then(() => {
          if (booth.gallery().enabled) {
            gallery.startBackgroundSync();
          }
        });
    }),
  ],
};
