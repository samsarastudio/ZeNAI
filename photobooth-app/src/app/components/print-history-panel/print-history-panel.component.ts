import { Component, OnDestroy, OnInit, computed, input, output, signal } from '@angular/core';

export interface PrintHistoryJob {
  id: string;
  createdAt?: string;
  canId?: string | null;
  canLabel?: string | null;
  printStatus?: string;
  uploadStatus?: string;
  aiPath?: string | null;
  lastPrintAt?: string | null;
}

@Component({
  selector: 'pb-print-history-panel',
  imports: [],
  templateUrl: './print-history-panel.component.html',
  styleUrl: './print-history-panel.component.scss',
})
export class PrintHistoryPanelComponent implements OnInit, OnDestroy {
  /** Rows per page. */
  readonly pageSize = input(8);
  readonly closed = output<void>();

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly jobs = signal<PrintHistoryJob[]>([]);
  readonly page = signal(1);
  readonly selectedId = signal<string | null>(null);
  readonly previewUrl = signal<string | null>(null);
  readonly thumbUrls = signal<Record<string, string>>({});
  readonly reprintBusy = signal(false);
  readonly reprintMsg = signal<string | null>(null);

  private jobsUnsub?: () => void;

  readonly printable = computed(() =>
    this.jobs()
      .filter((j) => !!j.aiPath)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  );

  readonly pageCount = computed(() => {
    const n = this.printable().length;
    const size = Math.max(1, this.pageSize());
    return Math.max(1, Math.ceil(n / size));
  });

  readonly pageItems = computed(() => {
    const size = Math.max(1, this.pageSize());
    const p = Math.min(this.page(), this.pageCount());
    const start = (p - 1) * size;
    return this.printable().slice(start, start + size);
  });

  readonly selected = computed(() => {
    const id = this.selectedId();
    return this.printable().find((j) => j.id === id) ?? null;
  });

  ngOnInit(): void {
    this.jobsUnsub = window.pbApi?.onJobsUpdated?.(() => {
      void this.reload(false);
    });
    void this.reload(true);
  }

  ngOnDestroy(): void {
    this.jobsUnsub?.();
  }

  async reload(resetPage = false): Promise<void> {
    if (!window.pbApi?.jobsList) {
      this.err.set('Print history requires Electron.');
      return;
    }
    this.loading.set(true);
    this.err.set(null);
    try {
      const r = await window.pbApi.jobsList();
      if (!r?.ok) {
        this.err.set('Could not load print history.');
        this.jobs.set([]);
        return;
      }
      const list = ((r.jobs || []) as unknown as PrintHistoryJob[]).filter((j) => !!j.aiPath);
      this.jobs.set(list);
      if (resetPage) this.page.set(1);
      await this.ensureThumbs(this.pageItems());
      const keep = list.find((j) => j.id === this.selectedId());
      if (keep) {
        await this.selectJob(keep);
      } else if (this.pageItems()[0]) {
        await this.selectJob(this.pageItems()[0]);
      } else {
        this.selectedId.set(null);
        this.previewUrl.set(null);
      }
    } catch (e) {
      this.err.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  goPage(delta: number): void {
    const next = Math.min(this.pageCount(), Math.max(1, this.page() + delta));
    this.page.set(next);
    void this.ensureThumbs(this.pageItems()).then(async () => {
      const first = this.pageItems()[0];
      if (first) await this.selectJob(first);
    });
  }

  async selectJob(job: PrintHistoryJob): Promise<void> {
    this.selectedId.set(job.id);
    this.reprintMsg.set(null);
    void this.ensureThumbs([job]);
    if (!job.aiPath || !window.pbApi?.readFileBase64) {
      this.previewUrl.set(null);
      return;
    }
    try {
      this.previewUrl.set(await window.pbApi.readFileBase64(job.aiPath));
    } catch {
      this.previewUrl.set(null);
    }
  }

  async reprint(): Promise<void> {
    const job = this.selected();
    if (!job?.aiPath || !window.pbApi?.jobsPrintOp) return;
    this.reprintBusy.set(true);
    this.reprintMsg.set(null);
    try {
      const r = await window.pbApi.jobsPrintOp({ id: job.id, op: 'reprint' });
      if (r?.ok) {
        this.reprintMsg.set('Queued for print.');
        await this.reload(false);
      } else {
        this.reprintMsg.set('Reprint failed.');
      }
    } catch (e) {
      this.reprintMsg.set(String(e));
    } finally {
      this.reprintBusy.set(false);
    }
  }

  formatWhen(iso?: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  close(): void {
    this.closed.emit();
  }

  private async ensureThumbs(items: PrintHistoryJob[]): Promise<void> {
    if (!window.pbApi?.readFileThumbBase64) return;
    const map = { ...this.thumbUrls() };
    for (const job of items) {
      if (!job.aiPath || map[job.id]) continue;
      try {
        map[job.id] = await window.pbApi.readFileThumbBase64(job.aiPath, 240);
      } catch {
        /* skip */
      }
    }
    this.thumbUrls.set(map);
  }
}
