import { Injectable, OnDestroy, computed, signal } from '@angular/core';

export type BoothLogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface BoothLogEntry {
  id: number;
  ts: string;
  level: BoothLogLevel;
  scope: string;
  message: string;
  detail?: string;
}

const MAX_ENTRIES = 800;

/**
 * Offline local logging via Electron → `<portable>/logs/photobooth.log`.
 * Keeps an in-memory ring buffer for the Admin debug panel / floating dock.
 */
@Injectable({ providedIn: 'root' })
export class BoothLogService implements OnDestroy {
  private logFilePath: string | null = null;
  private seq = 0;
  private unsubMain?: () => void;

  private readonly buffer = signal<BoothLogEntry[]>([]);
  readonly entries = computed(() => this.buffer());
  readonly entryCount = computed(() => this.buffer().length);

  constructor() {
    if (typeof window !== 'undefined') {
      this.unsubMain = window.pbApi?.onAppLogEntry?.((raw) => {
        this.pushLocal({
          ts: raw?.ts || new Date().toISOString(),
          level: (raw?.level as BoothLogLevel) || 'info',
          scope: raw?.scope || 'main',
          message: raw?.message || '',
          detail: raw?.detail,
        });
      });
    }
  }

  ngOnDestroy(): void {
    this.unsubMain?.();
  }

  async refreshLogPath(): Promise<string | null> {
    try {
      const paths = await window.pbApi?.getPaths();
      this.logFilePath = paths?.logFile ?? paths?.logsDir ?? null;
      return this.logFilePath;
    } catch {
      return null;
    }
  }

  getCachedLogPath(): string | null {
    return this.logFilePath;
  }

  clear(): void {
    this.buffer.set([]);
  }

  async loadTailFromDisk(maxLines = 250): Promise<void> {
    if (!window.pbApi?.readLogTail) return;
    try {
      const r = await window.pbApi.readLogTail({ maxLines });
      if (!r?.ok || !Array.isArray(r.lines)) return;
      const parsed: BoothLogEntry[] = [];
      for (const line of r.lines) {
        const m = String(line).match(
          /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*?)(?:\s+\|\s+(.*))?$/,
        );
        if (m) {
          parsed.push({
            id: ++this.seq,
            ts: m[1],
            level: m[2].toLowerCase() as BoothLogLevel,
            scope: m[3],
            message: m[4] || '',
            detail: m[5],
          });
        } else if (line.trim()) {
          parsed.push({
            id: ++this.seq,
            ts: new Date().toISOString(),
            level: 'info',
            scope: 'log',
            message: line.trim(),
          });
        }
      }
      this.buffer.set(parsed.slice(-MAX_ENTRIES));
      if (r.logFile) this.logFilePath = r.logFile;
    } catch {
      /* ignore */
    }
  }

  async log(
    level: BoothLogLevel,
    scope: string,
    message: string,
    detail?: unknown,
  ): Promise<void> {
    const detailStr = formatDetail(detail);
    this.pushLocal({
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      detail: detailStr,
    });
    try {
      if (!window.pbApi?.log) return;
      const r = await window.pbApi.log({
        level,
        scope,
        message,
        detail,
        skipBroadcast: true, // already in panel; avoid duplicate from main echo
      });
      if (r?.logFile) this.logFilePath = r.logFile;
    } catch {
      /* never break guest flow for logging */
    }
  }

  info(scope: string, message: string, detail?: unknown): Promise<void> {
    return this.log('info', scope, message, detail);
  }

  warn(scope: string, message: string, detail?: unknown): Promise<void> {
    return this.log('warn', scope, message, detail);
  }

  error(scope: string, message: string, detail?: unknown): Promise<void> {
    return this.log('error', scope, message, detail);
  }

  debug(scope: string, message: string, detail?: unknown): Promise<void> {
    return this.log('debug', scope, message, detail);
  }

  async openLogsFolder(): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!window.pbApi?.openLogsFolder) {
      return { ok: false, error: 'Logs require Electron.' };
    }
    return window.pbApi.openLogsFolder();
  }

  private pushLocal( partial: {
    ts: string;
    level: BoothLogLevel;
    scope: string;
    message: string;
    detail?: unknown;
  }): void {
    const entry: BoothLogEntry = {
      id: ++this.seq,
      ts: partial.ts,
      level: partial.level,
      scope: partial.scope,
      message: partial.message,
      detail: formatDetail(partial.detail),
    };
    this.buffer.update((list) => {
      const next = [...list, entry];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }
}

function formatDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null || detail === '') return undefined;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
