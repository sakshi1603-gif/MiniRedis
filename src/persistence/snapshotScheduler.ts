// Day 8: auto-save + shutdown save.
// Decoupled from your Store: you inject `build` (sync, consistent snapshot)
// and `write` (async, tmp file + rename). Wire these to your persistence.ts.
export type SaveRule = [seconds: number, minChanges: number];

export interface SchedulerDeps<S> {
  /** Must be synchronous: this is what makes the snapshot point-in-time consistent. */
  build: () => S;
  /** Async write. Should write to a tmp file and rename (atomic). */
  write: (snapshot: S) => Promise<void>;
}

export interface SchedulerOptions {
  /** Save if >= minChanges writes AND >= seconds since last save. */
  rules?: SaveRule[];
  tickMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export class SnapshotScheduler<S = unknown> {
  private dirty = 0;
  private saving = false;
  private lastSave: number;
  private timer?: NodeJS.Timeout;

  private readonly rules: SaveRule[];
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;

  constructor(private deps: SchedulerDeps<S>, opts: SchedulerOptions = {}) {
    this.rules = opts.rules ?? [[60, 1], [10, 100]];
    this.tickMs = opts.tickMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? ((e) => console.error("autosave failed:", e));
    this.lastSave = this.now();
  }

  get dirtyCount() { return this.dirty; }
  get isSaving() { return this.saving; }

  /** Call from SET / DEL / EXPIRE etc. only when something actually changed. */
  markDirty(n = 1) { this.dirty += n; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkRules(), this.tickMs);
    this.timer.unref(); // don't keep the process alive just for autosave
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exposed so tests can drive it without real timers. */
  checkRules() {
    const elapsed = (this.now() - this.lastSave) / 1000;
    if (this.rules.some(([s, c]) => elapsed >= s && this.dirty >= c)) {
      this.save().catch(this.onError);
    }
  }

  /** Returns false if a save is already running (BGSAVE vs autosave must not overlap). */
  async save(): Promise<boolean> {
    if (this.saving) return false;
    this.saving = true;
    const dirtyAtSnapshot = this.dirty;
    try {
      const snap = this.deps.build();      // sync = consistent
      await this.deps.write(snap);         // async; writes may arrive meanwhile
      this.dirty -= dirtyAtSnapshot;       // NOT = 0, or you lose count of in-flight writes
      this.lastSave = this.now();
      return true;
    } finally {
      this.saving = false;
    }
  }

  /** Call on SIGINT/SIGTERM. Waits for in-flight save, then saves if anything changed. */
  async finalSave() {
    this.stop();
    while (this.saving) await new Promise((r) => setTimeout(r, 10));
    if (this.dirty > 0) await this.save();
  }
}
