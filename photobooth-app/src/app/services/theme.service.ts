import { Injectable, inject } from '@angular/core';
import { BoothConfigService } from './booth-config.service';

const LINK_ID = 'pb-theme-pack-stylesheet';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly booth = inject(BoothConfigService);

  async applyFromConfig(): Promise<void> {
    const id = this.booth.activeThemeId();
    document.documentElement.setAttribute('data-pb-theme', id);

    const elOld = document.getElementById(LINK_ID);
    elOld?.remove();

    if (!window.pbApi?.adminGetThemeStylesheetUrl) {
      return;
    }
    const r = await window.pbApi.adminGetThemeStylesheetUrl();
    if (!r.ok || !r.url) {
      return;
    }

    // Wait until the theme CSS is applied so the attract screen never flashes unstyled.
    await new Promise<void>((resolve) => {
      const link = document.createElement('link');
      link.id = LINK_ID;
      link.rel = 'stylesheet';
      link.href = `${r.url}?v=${Date.now()}`;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      link.addEventListener('load', done);
      link.addEventListener('error', done);
      // Safety net — never block app start forever
      setTimeout(done, 2500);
      document.head.appendChild(link);
      // Cached stylesheets may already be complete
      // (some Electron builds fire neither load nor error reliably)
      requestAnimationFrame(() => {
        try {
          for (const sheet of Array.from(document.styleSheets)) {
            if (sheet.ownerNode === link) {
              done();
              break;
            }
          }
        } catch {
          /* cross-origin / file URL access can throw — ignore */
        }
      });
    });
  }
}
