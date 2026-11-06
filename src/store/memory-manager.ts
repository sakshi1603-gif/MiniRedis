import { LruIndex } from "./lru";
// Rough per-entry bookkeeping cost (Map slot, list node, object headers).
// Real Redis also approximates; say this in interviews.
const ENTRY_OVERHEAD = 64;

export class OomError extends Error {
  constructor() {
    super("OOM command not allowed: value larger than maxmemory");
  }
}

export function estimateSize(key: string, value: string): number {
  return Buffer.byteLength(key) + Buffer.byteLength(value) + ENTRY_OVERHEAD;
}

export class MemoryManager {
  private sizes = new Map<string, number>();
  private lru = new LruIndex();
  private used = 0;
  evictedKeys = 0;

  /**
   * @param maxBytes 0 = unlimited
   * @param onEvict  called for each evicted key; must delete it from the store
   *                 (data + expiry) but does NOT need to call recordDelete.
   */
  constructor(
    private maxBytes: number,
    private onEvict: (key: string) => void,
  ) {}

  get usedBytes(): number {
    return this.used;
  }
  get limit(): number {
    return this.maxBytes;
  }

  /** Check BEFORE writing so a single oversized value can't wipe the whole cache. */
  canFit(size: number): boolean {
    return this.maxBytes === 0 || size <= this.maxBytes;
  }

  /** Call after every SET (and when loading a snapshot). Returns evicted keys. */
  recordWrite(key: string, size: number): string[] {
    if (!this.canFit(size)) throw new OomError();
    this.used += size - (this.sizes.get(key) ?? 0);
    this.sizes.set(key, size);
    this.lru.touch(key); // new key is now MRU, so it is evicted last

    const evicted: string[] = [];
    while (this.maxBytes > 0 && this.used > this.maxBytes) {
      const victim = this.lru.evict();
      if (victim === undefined) break;
      this.used -= this.sizes.get(victim) ?? 0;
      this.sizes.delete(victim);
      this.evictedKeys++;
      this.onEvict(victim);
      evicted.push(victim);
    }
    return evicted;
  }

  /** Call on every successful GET (and any other read that should count as use). */
  recordAccess(key: string): void {
    if (this.lru.has(key)) this.lru.touch(key);
  }

  /** Call on DEL, TTL expiry, or anything else that removes a key. Idempotent. */
  recordDelete(key: string): void {
    if (!this.lru.remove(key)) return;
    this.used -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
  }
}

/**
 * Parse a maxmemory setting: "0", "5000", "10kb", "100mb", "2gb" (case-insensitive, 1kb = 1024).
 * undefined / "" => 0 (unlimited). Throws on garbage so a typo fails at startup, not silently.
 */
export function parseMemory(input: string | undefined): number {
  if (input === undefined || input.trim() === "") return 0;
  const m = /^(\d+)\s*(b|kb|mb|gb)?$/i.exec(input.trim());
  if (!m)
    throw new Error(
      `Invalid MAXMEMORY value: "${input}" (use e.g. 100mb, 512kb, 4096)`,
    );
  const unit = (m[2] ?? "b").toLowerCase();
  const mult =
    unit === "gb"
      ? 1024 ** 3
      : unit === "mb"
        ? 1024 ** 2
        : unit === "kb"
          ? 1024
          : 1;
  return Number(m[1]) * mult;
}
