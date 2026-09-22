import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { setAdminSession } from '../admin.guard';

@Component({
  selector: 'pb-admin-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './admin-login.component.html',
  styleUrl: './admin-login.component.scss',
})
export class AdminLoginComponent implements OnInit {
  pin = '';
  readonly err = signal<string | null>(null);
  readonly busy = signal(false);
  /** Shipped default from `photobooth-config.default.json` (not necessarily the live PIN if config was edited). */
  readonly defaultPin = signal<string | null>(null);
  readonly pinInfoOpen = signal(false);

  constructor(private readonly router: Router) {}

  ngOnInit(): void {
    void fetch('/config/photobooth-config.default.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const p = j && typeof j['adminPin'] === 'string' ? (j['adminPin'] as string) : null;
        this.defaultPin.set(p ?? '2727');
      })
      .catch(() => this.defaultPin.set('2727'));
  }

  togglePinInfo(): void {
    this.pinInfoOpen.update((v) => !v);
  }

  async submit(): Promise<void> {
    this.err.set(null);
    if (!window.pbApi?.adminVerifyPin) {
      this.err.set('Admin login requires the desktop app (Electron).');
      return;
    }
    this.busy.set(true);
    try {
      const r = await window.pbApi.adminVerifyPin(this.pin);
      if (r.ok && r.valid) {
        setAdminSession(true);
        await this.router.navigate(['/admin']);
        return;
      }
      this.err.set('Incorrect PIN.');
    } catch (e) {
      this.err.set(String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
