import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DebugLogDockComponent } from './components/debug-log-dock/debug-log-dock.component';
import { KioskIdleService } from './services/kiosk-idle.service';

@Component({
  selector: 'pb-root',
  imports: [RouterOutlet, DebugLogDockComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'photobooth-app';
  readonly kioskIdle = inject(KioskIdleService);

  ngOnInit(): void {
    this.kioskIdle.start();
  }

  ngOnDestroy(): void {
    this.kioskIdle.stop();
  }
}
