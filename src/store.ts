type Entry = { value: string; expiresAt: number | null };

export class Store {
  private data = new Map<string, Entry>();

  private withTtl = new Set<string>();

  private timer?: NodeJS.Timeout;

  constructor(private now: () => number = Date.now) {}

  start(sweepMs = 100): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get size(): number {
    return this.data.size;
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
   * DAY 7 — raw insert used when loading a snapshot.
   * expiresAt is an ABSOLUTE epoch ms (not a TTL), so we bypass set()/expire().
   * Returns false if the entry is already expired and was skipped.
   * Uses the injectable clock (this.now) so tests can fake time without sleeping.
   */
  restore(key: string, value: string, expiresAt: number | null): boolean {
    if (expiresAt !== null && expiresAt <= this.now()) return false;
    this.data.set(key, { value, expiresAt });
    // The sweeper only looks at keys in withTtl; forget this and restored
    // TTL keys that are never read again would never be cleaned up.
    if (expiresAt !== null) this.withTtl.add(key);
    else this.withTtl.delete(key);
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
  }

  set(key: string, value: string, ttlSeconds?: number): void {
    this.data.set(key, { value, expiresAt: null });
    this.withTtl.delete(key);
    if (ttlSeconds !== undefined) this.expire(key, ttlSeconds);
  }

  get(key: string): string | null {
    return this.live(key)?.value ?? null;
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
    for (const k of keys) if (this.live(k)) n++;
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
    const e = this.live(key);
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
