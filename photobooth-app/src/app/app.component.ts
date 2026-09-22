import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DebugLogDockComponent } from './components/debug-log-dock/debug-log-dock.component';

@Component({
  selector: 'pb-root',
  imports: [RouterOutlet, DebugLogDockComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'photobooth-app';
}
