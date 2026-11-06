import { describe, it, expect } from "vitest";
import { LruIndex } from "./lru";
import { MemoryManager, OomError, estimateSize } from "./memory-manager";

describe("LruIndex", () => {
  it("orders MRU to LRU and evicts the tail", () => {
    const l = new LruIndex();
    ["a", "b", "c"].forEach((k) => l.touch(k));
    expect(l.keys()).toEqual(["c", "b", "a"]);
    expect(l.evict()).toBe("a");
    expect(l.keys()).toEqual(["c", "b"]);
  });

  it("touch moves an existing key to the front", () => {
    const l = new LruIndex();
    ["a", "b", "c"].forEach((k) => l.touch(k));
    l.touch("a");
    expect(l.keys()).toEqual(["a", "c", "b"]);
    expect(l.evict()).toBe("b");
  });

  it("handles empty, single, and remove cases", () => {
    const l = new LruIndex();
    expect(l.evict()).toBeUndefined();
    l.touch("a");
    expect(l.remove("a")).toBe(true);
    expect(l.remove("a")).toBe(false);
    expect(l.size).toBe(0);
    l.touch("x");
    l.touch("x");
    expect(l.keys()).toEqual(["x"]);
  });
});

describe("MemoryManager", () => {
  const sz = estimateSize("k1", "v"); // same for k1..k9 with 1-char values

  function setup(slots: number) {
    const store = new Map<string, string>();
    const mm = new MemoryManager(sz * slots, (k) => store.delete(k));
    const set = (k: string, v: string) => {
      mm.recordWrite(k, estimateSize(k, v));
      store.set(k, v);
    };
    const get = (k: string) => {
      const v = store.get(k);
      if (v !== undefined) mm.recordAccess(k);
      return v;
    };
    return { store, mm, set, get };
  }

  it("evicts the least recently used key when full", () => {
    const { store, set } = setup(3);
    set("k1", "v");
    set("k2", "v");
    set("k3", "v");
    set("k4", "v");
    expect(store.has("k1")).toBe(false);
    expect([...store.keys()].sort()).toEqual(["k2", "k3", "k4"]);
  });

  it("GET protects a key from eviction", () => {
    const { store, set, get } = setup(3);
    set("k1", "v");
    set("k2", "v");
    set("k3", "v");
    get("k1");
    set("k4", "v");
    expect(store.has("k1")).toBe(true);
    expect(store.has("k2")).toBe(false);
  });

  it("overwrite updates size, does not double count", () => {
    const { mm, set } = setup(3);
    set("k1", "v");
    set("k1", "v");
    set("k1", "v");
    expect(mm.usedBytes).toBe(sz);
  });

  it("delete frees bytes and is idempotent", () => {
    const { mm, set } = setup(3);
    set("k1", "v");
    mm.recordDelete("k1");
    mm.recordDelete("k1");
    expect(mm.usedBytes).toBe(0);
  });

  it("evicts multiple keys when a big value arrives", () => {
    const { store, set } = setup(3);
    set("k1", "v");
    set("k2", "v");
    set("k3", "v");
    set("big", "x".repeat(sz)); // roughly 2 slots worth
    expect(store.has("big")).toBe(true);
    expect(store.size).toBeLessThan(3);
  });

  it("rejects a value bigger than maxmemory without evicting anything", () => {
    const { store, set } = setup(1);
    set("k1", "v");
    expect(() => set("huge", "x".repeat(10_000))).toThrow(OomError);
    expect(store.has("k1")).toBe(true);
  });

  it("limit 0 means unlimited", () => {
    const mm = new MemoryManager(0, () => {});
    for (let i = 0; i < 1000; i++) mm.recordWrite("k" + i, 1000);
    expect(mm.evictedKeys).toBe(0);
  });
});
