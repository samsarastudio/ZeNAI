import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BoothConfigService } from '../../services/booth-config.service';
import { CapturePhotoBrowserComponent } from '../../components/capture-photo-browser/capture-photo-browser.component';

@Component({
  selector: 'pb-history-page',
  imports: [RouterLink, CapturePhotoBrowserComponent],
  templateUrl: './history-page.component.html',
  styleUrl: './history-page.component.scss',
})
export class HistoryPageComponent {
  private readonly booth = inject(BoothConfigService);
  readonly copy = this.booth.copy;
}
