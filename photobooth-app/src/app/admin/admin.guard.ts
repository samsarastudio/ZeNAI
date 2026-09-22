import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

const SESSION_KEY = 'pb_admin_session';

export function adminSessionOk(): boolean {
  return sessionStorage.getItem(SESSION_KEY) === '1';
}

export function setAdminSession(ok: boolean): void {
  if (ok) {
    sessionStorage.setItem(SESSION_KEY, '1');
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

export const adminGuard: CanActivateFn = () => {
  const router = inject(Router);
  if (adminSessionOk()) {
    return true;
  }
  return router.createUrlTree(['/admin/login']);
};
