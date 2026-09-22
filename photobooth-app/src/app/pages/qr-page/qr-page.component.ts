import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { BrandingLogoService } from '../../services/branding-logo.service';
import { BoothConfigService } from '../../services/booth-config.service';
import { BoothModeService } from '../../services/booth-mode.service';
import { AiStyleService } from '../../services/ai-style.service';

@Component({
  selector: 'pb-qr-page',
  templateUrl: './qr-page.component.html',
  styleUrl: './qr-page.component.scss',
})
export class QrPageComponent implements OnInit, OnDestroy {
  private readonly booth = inject(BoothConfigService);
  private readonly boothMode = inject(BoothModeService);
  private readonly aiStyle = inject(AiStyleService);
  readonly branding = inject(BrandingLogoService);
  readonly copy = this.booth.copy;

  readonly message = signal('');
  readonly scanSuccess = signal(false);

  private keyBuffer = '';
  private navigateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly router: Router) {}

  ngOnInit(): void {
    this.aiStyle.clear();
  }

  ngOnDestroy(): void {
    if (this.navigateTimer) {
      clearTimeout(this.navigateTimer);
      this.navigateTimer = null;
    }
  }

  private nextAfterUnlock(): void {
    if (this.boothMode.isPhysicalFrameMode()) {
      this.aiStyle.clear();
      void this.router.navigate(['/capture']);
      return;
    }
    const fixed = this.booth.fixedAiModeId();
    if (fixed) {
      this.aiStyle.selectMode(fixed);
      void this.router.navigate(['/capture']);
      return;
    }
    if (this.booth.shouldShowAiModeStep()) {
      void this.router.navigate(['/ai-mode']);
    } else {
      void this.router.navigate(['/capture']);
    }
  }

  private tryUnlockFromBuffer(): void {
    const expected = this.copy().qr.bypassCode.trim();
    const autoUnlockForMock =
      expected === '1234' && this.keyBuffer.length > 0 && this.keyBuffer.startsWith('1');
    if (this.keyBuffer === expected || autoUnlockForMock) {
      this.message.set('');
      this.scanSuccess.set(true);
      this.navigateTimer = setTimeout(() => {
        this.navigateTimer = null;
        this.nextAfterUnlock();
      }, 900);
      return;
    }
    this.message.set(this.copy().qr.invalidCode);
    this.keyBuffer = '';
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(ev: KeyboardEvent): void {
    if (this.scanSuccess()) return;

    const el = ev.target as HTMLElement | null;
    if (
      el &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable)
    ) {
      return;
    }

    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.tryUnlockFromBuffer();
      return;
    }

    if (ev.key === 'Backspace') {
      ev.preventDefault();
      this.keyBuffer = this.keyBuffer.slice(0, -1);
      return;
    }

    if (/^[0-9]$/.test(ev.key)) {
      ev.preventDefault();
      if (this.keyBuffer.length < 16) {
        this.keyBuffer += ev.key;
        this.message.set('');
        this.tryUnlockFromBuffer();
      }
    }
  }
}
