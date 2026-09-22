import { Injectable, signal } from '@angular/core';

export interface GuestConsents {
  terms: boolean;
  age: boolean;
  imageUse: boolean;
  marketing: boolean;
}

@Injectable({ providedIn: 'root' })
export class GuestSessionService {
  readonly canId = signal<string | null>(null);
  readonly canLabel = signal<string | null>(null);
  readonly email = signal('');
  readonly firstName = signal('');
  readonly lastName = signal('');
  readonly jobId = signal<string | null>(null);
  /** Local capture file path pending review (before AI job enqueue). */
  readonly capturePath = signal<string | null>(null);
  readonly consents = signal<GuestConsents>({
    terms: false,
    age: false,
    imageUse: false,
    marketing: false,
  });

  selectCan(id: string, label: string): void {
    this.canId.set(id);
    this.canLabel.set(label);
  }

  setCapturePath(path: string | null): void {
    this.capturePath.set(path);
  }

  setDetails(email: string, consents: GuestConsents, firstName = '', lastName = ''): void {
    this.email.set(email.trim());
    this.firstName.set(firstName.trim());
    this.lastName.set(lastName.trim());
    this.consents.set({ ...consents });
  }

  clear(): void {
    this.canId.set(null);
    this.canLabel.set(null);
    this.email.set('');
    this.firstName.set('');
    this.lastName.set('');
    this.jobId.set(null);
    this.capturePath.set(null);
    this.consents.set({ terms: false, age: false, imageUse: false, marketing: false });
  }
}
