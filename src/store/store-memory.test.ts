import { describe, it, expect } from "vitest";
import { Store } from "./store";
import { OomError, estimateSize } from "./memory-manager";

const SLOT = estimateSize("k1", "v");
const mk = (slots: number, now = () => 0) => new Store(now, SLOT * slots);

describe("Store + LRU", () => {
  it("evicts the least recently used key when full", () => {
    const s = mk(3);
    s.set("k1", "v"); s.set("k2", "v"); s.set("k3", "v"); s.set("k4", "v");
    expect(s.get("k1")).toBeNull();
    expect(s.size).toBe(3);
    expect(s.memoryStats().evictedKeys).toBe(1);
  });

  it("GET and EXISTS protect a key", () => {
    const s = mk(3);
    s.set("k1", "v"); s.set("k2", "v"); s.set("k3", "v");
    s.get("k1");
    s.exists(["k2"]);
    s.set("k4", "v");
    expect(s.get("k3")).toBeNull();
    expect(s.get("k1")).toBe("v");
    expect(s.get("k2")).toBe("v");
  });

  it("TTL does not count as access", () => {
    const s = mk(2);
    s.set("k1", "v"); s.set("k2", "v");
    s.ttl("k1");
    s.set("k3", "v");
    expect(s.get("k1")).toBeNull();
  });

  it("DEL and TTL expiry free bytes", () => {
    let t = 0;
    const s = mk(3, () => t);
    s.set("k1", "v"); s.set("k2", "v", 1);
    s.del(["k1"]);
    t = 2000;
    s.sweep();
    expect(s.size).toBe(0);
    expect(s.memoryStats().usedBytes).toBe(0);
  });

  it("overwrite does not double count", () => {
    const s = mk(3);
    s.set("k1", "v"); s.set("k1", "v");
    expect(s.memoryStats().usedBytes).toBe(SLOT);
  });

  it("oversized value throws OomError and changes nothing", () => {
    const s = mk(1);
    s.set("k1", "v");
    expect(() => s.set("big", "x".repeat(10_000))).toThrow(OomError);
    expect(s.get("k1")).toBe("v");
  });

  it("restore trims a too-large snapshot", () => {
    const s = mk(2);
    s.restore("k1", "v", null); s.restore("k2", "v", null); s.restore("k3", "v", null);
    expect(s.size).toBe(2);
    expect(s.get("k1")).toBeNull();
  });

  it("default is unlimited", () => {
    const s = new Store();
    for (let i = 0; i < 2000; i++) s.set("k" + i, "v");
    expect(s.size).toBe(2000);
    expect(s.memoryStats().evictedKeys).toBe(0);
  });
});
