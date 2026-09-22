import { Routes } from '@angular/router';
import { AdminDashboardComponent } from './admin/admin-dashboard/admin-dashboard.component';
import { AdminLoginComponent } from './admin/admin-login/admin-login.component';
import { adminGuard } from './admin/admin.guard';
import { AttractPageComponent } from './pages/attract-page/attract-page.component';
import { CapturePageComponent } from './pages/capture-page/capture-page.component';
import { CanSelectPageComponent } from './pages/can-select-page/can-select-page.component';
import { DetailsPageComponent } from './pages/details-page/details-page.component';
import { PreviewPageComponent } from './pages/preview-page/preview-page.component';
import { ReviewPageComponent } from './pages/review-page/review-page.component';
import { ThanksPageComponent } from './pages/thanks-page/thanks-page.component';

export const routes: Routes = [
  { path: '', component: AttractPageComponent },
  { path: 'cans', component: CanSelectPageComponent },
  { path: 'details', component: DetailsPageComponent },
  { path: 'capture', component: CapturePageComponent },
  { path: 'review', component: ReviewPageComponent },
  { path: 'preview', component: PreviewPageComponent },
  { path: 'thanks', component: ThanksPageComponent },
  { path: 'admin/login', component: AdminLoginComponent },
  { path: 'admin', canActivate: [adminGuard], component: AdminDashboardComponent },
  { path: '**', redirectTo: '' },
];
