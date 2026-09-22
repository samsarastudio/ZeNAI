import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { BoothConfigService } from '../../services/booth-config.service';
import { GuestSessionService } from '../../services/guest-session.service';
import { BrandingLogoService } from '../../services/branding-logo.service';

@Component({
  selector: 'pb-details-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './details-page.component.html',
  styleUrl: './details-page.component.scss',
})
export class DetailsPageComponent implements OnInit {
  private readonly booth = inject(BoothConfigService);
  private readonly session = inject(GuestSessionService);
  private readonly router = inject(Router);
  readonly branding = inject(BrandingLogoService);
  readonly copy = this.booth.copy;
  email = '';
  firstName = '';
  lastName = '';
  terms = false;
  age = false;
  imageUse = false;
  marketing = false;
  readonly err = signal<string | null>(null);

  ngOnInit(): void {
    if (!this.session.canId()) {
      void this.router.navigate(['/cans']);
      return;
    }
    this.email = this.session.email();
    this.firstName = this.session.firstName();
    this.lastName = this.session.lastName();
    const c = this.session.consents();
    this.terms = c.terms;
    this.age = c.age;
    this.imageUse = c.imageUse;
    this.marketing = c.marketing;
  }

  async continue(): Promise<void> {
    this.err.set(null);
    if (!this.firstName.trim()) {
      this.err.set('Enter your first name.');
      return;
    }
    const mail = this.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      this.err.set('Enter a valid email address.');
      return;
    }
    if (!this.terms || !this.age || !this.imageUse) {
      this.err.set('Please accept the required confirmations.');
      return;
    }
    this.session.setDetails(
      mail,
      {
        terms: this.terms,
        age: this.age,
        imageUse: this.imageUse,
        marketing: this.marketing,
      },
      this.firstName,
      this.lastName,
    );
    await this.router.navigate(['/capture']);
  }

  typeChar(ch: string): void {
    if (this.email.length >= 80) return;
    this.email += ch;
  }

  backspace(): void {
    this.email = this.email.slice(0, -1);
  }
}
