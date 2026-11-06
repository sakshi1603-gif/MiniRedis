import { MemoryManager, estimateSize, OomError } from "./memory-manager";

type Entry = { value: string; expiresAt: number | null };

export class Store {
  private data = new Map<string, Entry>();

  private withTtl = new Set<string>();

  private timer?: NodeJS.Timeout;

  // LRU + byte accounting. maxMemoryBytes = 0 means unlimited (old behaviour).
  private mm: MemoryManager;

  constructor(
    private now: () => number = Date.now,
    maxMemoryBytes = 0,
  ) {
    // Eviction callback: the manager already dropped its own bookkeeping,
    // we only remove the data. removeKey's recordDelete is a harmless no-op here.
    this.mm = new MemoryManager(maxMemoryBytes, (k) => this.removeKey(k));
  }

  start(sweepMs = 100): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), sweepMs); //Active expiration
    this.timer.unref(); //Allows Node.js to exit naturally without this timer alone keeping the process alive.
  }
  // shutdown
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get size(): number {
    return this.data.size;
  }

  /** For INFO memory. */
  memoryStats(): { usedBytes: number; maxBytes: number; evictedKeys: number } {
    return {
      usedBytes: this.mm.usedBytes,
      maxBytes: this.mm.limit,
      evictedKeys: this.mm.evictedKeys,
    };
  }

  /** Yields every non-expired entry. Read-only: does not delete or mutate. */
  *liveEntries(): Generator<{ key: string; value: string; expiresAt: number | null }> {
    const t = this.now();
    for (const [key, e] of this.data) {
      if (e.expiresAt !== null && e.expiresAt <= t) continue;
      yield { key, value: e.value, expiresAt: e.expiresAt };
    }
  }

  /**
   *  raw insert used when loading a snapshot.
   * expiresAt is an ABSOLUTE epoch ms (not a TTL), so we bypass set()/expire().
   * Returns false if the entry is already expired (or larger than maxmemory) and was skipped.
   * Uses the injectable clock (this.now) so tests can fake time without sleeping.
   * If the snapshot is bigger than maxmemory, LRU eviction trims it as it loads.
   */
  restore(key: string, value: string, expiresAt: number | null): boolean {
    if (expiresAt !== null && expiresAt <= this.now()) return false;
    const size = estimateSize(key, value);
    if (!this.mm.canFit(size)) return false;
    this.data.set(key, { value, expiresAt });
    // The sweeper only looks at keys in withTtl; forget this and restored
    // TTL keys that are never read again would never be cleaned up.
    if (expiresAt !== null) this.withTtl.add(key);
    else this.withTtl.delete(key);
    this.mm.recordWrite(key, size); // may evict older keys (never this one: it is MRU)
    return true;
  }

  //lazy expiration
  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.removeKey(key);
      return undefined;
    }
    return e;
  }

  private removeKey(key: string): void {
    this.data.delete(key);
    this.withTtl.delete(key);
    this.mm.recordDelete(key); // keep usedBytes + LRU list in sync (idempotent)
  }

  /** Throws OomError if this single entry can never fit under maxmemory. */
  set(key: string, value: string, ttlSeconds?: number): void {
    const size = estimateSize(key, value);
    if (!this.mm.canFit(size)) throw new OomError(); // check BEFORE mutating
    this.data.set(key, { value, expiresAt: null });
    this.withTtl.delete(key);
    this.mm.recordWrite(key, size); // new key = MRU; evicts LRU keys if over limit
    if (ttlSeconds !== undefined) this.expire(key, ttlSeconds);
  }

  get(key: string): string | null {
    const e = this.live(key);
    if (!e) return null;
    this.mm.recordAccess(key);
    return e.value;
  }

  del(keys: string[]): number {
    let n = 0;
    for (const k of keys) {
      if (this.live(k)) {
        this.removeKey(k);
        n++;
      }
    }
    return n;
  }

  exists(keys: string[]): number {
    let n = 0;
    for (const k of keys) {
      if (this.live(k)) {
        this.mm.recordAccess(k); // Redis counts EXISTS as an access too
        n++;
      }
    }
    return n;
  }

  expire(key: string, seconds: number): 0 | 1 {
    const e = this.live(key);
    if (!e) return 0;
    if (seconds <= 0) {
      this.removeKey(key);
      return 1;
    }
    e.expiresAt = this.now() + seconds * 1000;
    this.withTtl.add(key);
    return 1;
  }

  ttl(key: string): number {
    const e = this.live(key); // no recordAccess: TTL is metadata, Redis doesn't touch LRU for it
    if (!e) return -2; //	Key doesn't exist
    if (e.expiresAt === null) return -1; //	Key exists but has no expiration
    return Math.ceil((e.expiresAt - this.now()) / 1000); //Remaining TTL in seconds
  }

  sweep(): void {
    const SAMPLE = 20;
    const MAX_ROUNDS = 10;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const batch: string[] = [];
      for (const k of this.withTtl) {
        if (batch.length >= SAMPLE) break;
        batch.push(k);
      }
      if (batch.length === 0) return;

      const t = this.now();
      let expired = 0;
      for (const k of batch) {
        const e = this.data.get(k);
        if (!e || e.expiresAt === null) {
          this.withTtl.delete(k);
        } else if (e.expiresAt <= t) {
          this.removeKey(k);
          expired++;
        } else {
          this.withTtl.delete(k);
          this.withTtl.add(k);
        }
      }
      if (expired <= SAMPLE / 4) return;
    }
  }
}
