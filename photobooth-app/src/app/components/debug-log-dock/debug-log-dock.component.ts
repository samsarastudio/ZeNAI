import { Component, ElementRef, ViewChild, effect, inject } from '@angular/core';
import { BoothConfigService } from '../../services/booth-config.service';
import { BoothLogService } from '../../services/booth-log.service';

@Component({
  selector: 'pb-debug-log-dock',
  templateUrl: './debug-log-dock.component.html',
  styleUrl: './debug-log-dock.component.scss',
})
export class DebugLogDockComponent {
  readonly booth = inject(BoothConfigService);
  readonly logs = inject(BoothLogService);

  collapsed = false;

  @ViewChild('scroller') private scroller?: ElementRef<HTMLElement>;

  constructor() {
    effect(() => {
      const _ = this.logs.entries();
      if (!this.booth.debugEnabled() || this.collapsed) return;
      queueMicrotask(() => this.scrollToBottom());
    });
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    if (!this.collapsed) queueMicrotask(() => this.scrollToBottom());
  }

  clear(): void {
    this.logs.clear();
  }

  private scrollToBottom(): void {
    const el = this.scroller?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }
}
