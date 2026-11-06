import { describe, it, expect } from "vitest";
import { execute } from "./commands";
import { Store } from "../store/store";
import * as enc from "../protocol/encode";
import { estimateSize, parseMemory } from "../store/memory-manager";

const SLOT = estimateSize("k1", "v");
const run = (s: Store, ...args: string[]) => execute(s, args);

describe("maxmemory via commands", () => {
  it("evicts oldest keys and reports it in INFO", () => {
    const s = new Store(() => 0, SLOT * 5);
    for (let i = 1; i <= 9; i++) run(s, "SET", "k" + i, "v");
    expect(run(s, "GET", "k1")).toBe(enc.bulk(null));
    expect(run(s, "GET", "k9")).toBe(enc.bulk("v"));
    const info = run(s, "INFO", "memory") + run(s, "INFO", "stats");
    expect(info).toContain(`maxmemory:${SLOT * 5}`);
    expect(info).toContain("evicted_keys:4");
    expect(info).toContain("used_memory:" + SLOT * 5);
  });

  it("recently read key survives the flood", () => {
    const s = new Store(() => 0, SLOT * 3);
    run(s, "SET", "k1", "v"); run(s, "SET", "k2", "v"); run(s, "SET", "k3", "v");
    run(s, "GET", "k1");
    run(s, "SET", "k4", "v");
    expect(run(s, "GET", "k1")).toBe(enc.bulk("v"));
    expect(run(s, "GET", "k2")).toBe(enc.bulk(null));
  });

  it("oversized SET returns -OOM and keeps existing data", () => {
    const s = new Store(() => 0, SLOT);
    run(s, "SET", "k1", "v");
    const r = run(s, "SET", "big", "x".repeat(5000));
    expect(r.startsWith("-OOM")).toBe(true);
    expect(run(s, "GET", "k1")).toBe(enc.bulk("v"));
  });

  it("CONFIG GET maxmemory", () => {
    const s = new Store(() => 0, 1234);
    expect(run(s, "CONFIG", "GET", "maxmemory")).toContain("1234");
  });
});

describe("parseMemory", () => {
  it("parses units", () => {
    expect(parseMemory(undefined)).toBe(0);
    expect(parseMemory("0")).toBe(0);
    expect(parseMemory("4096")).toBe(4096);
    expect(parseMemory("10kb")).toBe(10240);
    expect(parseMemory("100MB")).toBe(100 * 1024 * 1024);
    expect(parseMemory("2gb")).toBe(2 * 1024 ** 3);
  });
  it("throws on garbage", () => {
    expect(() => parseMemory("lots")).toThrow();
    expect(() => parseMemory("-5")).toThrow();
  });
});
