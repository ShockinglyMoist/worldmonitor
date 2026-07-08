import type { AppContext, AppModule } from '@/app/app-context';
import { startSmartPollLoop, VisibilityHub, type SmartPollLoopHandle } from '@/services/runtime';

export interface RefreshRegistration {
  name: string;
  fn: () => Promise<boolean | void>;
  intervalMs: number;
  condition?: () => boolean;
  runImmediately?: boolean;
}

export class RefreshScheduler implements AppModule {
  private ctx: AppContext;
  private refreshRunners = new Map<string, { loop: SmartPollLoopHandle; intervalMs: number; lastRunAt: number }>();
  private flushTimeoutIds = new Set<ReturnType<typeof setTimeout>>();
  private hiddenSince = 0;
  private visibilityHub = new VisibilityHub();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {}

  destroy(): void {
    for (const timeoutId of this.flushTimeoutIds) {
      clearTimeout(timeoutId);
    }
    this.flushTimeoutIds.clear();
    for (const { loop } of this.refreshRunners.values()) {
      loop.stop();
    }
    this.refreshRunners.clear();
    this.visibilityHub.destroy();
  }

  setHiddenSince(ts: number): void {
    this.hiddenSince = ts;
  }

  getHiddenSince(): number {
    return this.hiddenSince;
  }

  scheduleRefresh(
    name: string,
    fn: () => Promise<boolean | void>,
    intervalMs: number,
    condition?: () => boolean,
    options: { runImmediately?: boolean } = {},
  ): void {
    this.refreshRunners.get(name)?.loop.stop();

    const loop = startSmartPollLoop(async () => {
      if (this.ctx.isDestroyed) return;
      if (condition && !condition()) return;
      if (this.ctx.inFlight.has(name)) return;

      this.ctx.inFlight.add(name);
      try {
        return await fn();
      } finally {
        const entry = this.refreshRunners.get(name);
        if (entry) entry.lastRunAt = Date.now();
        this.ctx.inFlight.delete(name);
      }
    }, {
      intervalMs,
      pauseWhenHidden: true,
      refreshOnVisible: false,
      runImmediately: options.runImmediately ?? false,
      maxBackoffMultiplier: 4,
      visibilityHub: this.visibilityHub,
      onError: (e) => {
        console.error(`[App] Refresh ${name} failed:`, e);
      },
    });

    this.refreshRunners.set(name, { loop, intervalMs, lastRunAt: Date.now() });
  }

  flushStaleRefreshes(): void {
    if (!this.hiddenSince) return;
    this.hiddenSince = 0;

    for (const timeoutId of this.flushTimeoutIds) {
      clearTimeout(timeoutId);
    }
    this.flushTimeoutIds.clear();

    // Staleness is measured against the last COMPLETED run, not the length of
    // the most recent hidden stretch: every hide/show flip restarts each loop's
    // full countdown (smart-poll-loop discards elapsed time on resume), so
    // fragmented hidden periods shorter than the interval would otherwise keep
    // resetting the countdown and a loop could starve indefinitely.
    const stale: { loop: SmartPollLoopHandle; intervalMs: number }[] = [];
    for (const entry of this.refreshRunners.values()) {
      if (Date.now() - entry.lastRunAt >= entry.intervalMs) {
        stale.push(entry);
      }
    }
    stale.sort((a, b) => a.intervalMs - b.intervalMs);

    // Tiered stagger: first 4 gaps are 100ms (covering tasks 1-5), remaining gaps are 300ms
    const FLUSH_STAGGER_FAST_MS = 100;
    const FLUSH_STAGGER_SLOW_MS = 300;
    let stagger = 0;
    let idx = 0;
    for (const entry of stale) {
      const delay = stagger;
      stagger += (idx < 4) ? FLUSH_STAGGER_FAST_MS : FLUSH_STAGGER_SLOW_MS;
      idx++;
      const timeoutId = setTimeout(() => {
        this.flushTimeoutIds.delete(timeoutId);
        entry.loop.trigger();
      }, delay);
      this.flushTimeoutIds.add(timeoutId);
    }
  }

  registerAll(registrations: RefreshRegistration[]): void {
    for (const reg of registrations) {
      this.scheduleRefresh(reg.name, reg.fn, reg.intervalMs, reg.condition, {
        runImmediately: reg.runImmediately,
      });
    }
  }
}
