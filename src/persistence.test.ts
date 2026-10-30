import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";
import { saveSnapshot, loadSnapshot, startAutoSave, Snapshot } from "./persistence";
import { execute } from "./commands";

// ───────────────────────── DAY 6: save ─────────────────────────

describe("snapshot save", () => {
  let dir: string;
  let path: string;
  let t: number;
  let store: Store;

  const read = (): Snapshot => JSON.parse(readFileSync(path, "utf8"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mini-redis-"));
    path = join(dir, "dump.json");
    t = 1_000_000;
    store = new Store(() => t);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes all live keys", () => {
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    expect(saveSnapshot(store, path)).toBe(3);
    const keys = read().entries.map((e) => e.key).sort();
    expect(keys).toEqual(["a", "b", "c"]);
  });

  it("skips expired keys", () => {
    store.set("dead", "x", 10);
    store.set("alive", "y");
    t += 11_000;
    saveSnapshot(store, path);
    expect(read().entries.map((e) => e.key)).toEqual(["alive"]);
  });

  it("stores absolute expiresAt", () => {
    store.set("k", "v", 10);
    saveSnapshot(store, path);
    expect(read().entries[0].expiresAt).toBe(1_000_000 + 10_000);
  });

  it("stores null expiresAt for keys without TTL", () => {
    store.set("k", "v");
    saveSnapshot(store, path);
    expect(read().entries[0].expiresAt).toBeNull();
  });

  it("leaves no .tmp file behind", () => {
    store.set("k", "v");
    saveSnapshot(store, path);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("overwrites the previous snapshot", () => {
    store.set("old", "1");
    saveSnapshot(store, path);
    store.del(["old"]);
    store.set("new", "2");
    saveSnapshot(store, path);
    expect(read().entries.map((e) => e.key)).toEqual(["new"]);
  });

  it("does not mutate the store", () => {
    store.set("dead", "x", 10);
    t += 11_000;
    const sizeBefore = store.size;
    saveSnapshot(store, path);
    expect(store.size).toBe(sizeBefore);
  });
});

describe("SAVE command", () => {
  it("returns OK and writes the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-redis-"));
    const path = join(dir, "dump.json");
    const store = new Store();
    store.set("a", "1");
    expect(execute(store, ["SAVE"], path)).toBe("+OK\r\n");
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects extra arguments", () => {
    const res = execute(new Store(), ["SAVE", "now"]);
    expect(res).toContain("wrong number of arguments for 'save'");
  });

  it("returns an error instead of throwing on write failure", () => {
    const res = execute(new Store(), ["SAVE"], "/nonexistent-dir/dump.json");
    expect(res.startsWith("-ERR")).toBe(true);
  });
});

// ───────────────────────── DAY 7: load + autosave ─────────────────────────

describe("snapshot load", () => {
  let dir: string;
  let path: string;
  let t: number;
  let store: Store;

  const freshStore = (now = t) => new Store(() => now);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mini-redis-"));
    path = join(dir, "dump.json");
    t = 1_000_000;
    store = new Store(() => t);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round trip: save then load into a fresh store", () => {
    store.set("a", "1");
    store.set("b", "2");
    saveSnapshot(store, path);

    const fresh = freshStore();
    expect(loadSnapshot(fresh, path)).toBe(2);
    expect(fresh.get("a")).toBe("1");
    expect(fresh.get("b")).toBe("2");
  });

  it("keeps the same absolute deadline after reload", () => {
    store.set("k", "v", 100);
    saveSnapshot(store, path);

    const fresh = freshStore(t + 40_000); // restart 40s later
    loadSnapshot(fresh, path);
    expect(fresh.ttl("k")).toBe(60); // 100 - 40, not a fresh 100
  });

  it("keys without TTL stay without TTL", () => {
    store.set("k", "v");
    saveSnapshot(store, path);
    const fresh = freshStore();
    loadSnapshot(fresh, path);
    expect(fresh.ttl("k")).toBe(-1);
  });

  it("skips entries that expired while the server was down", () => {
    store.set("dead", "x", 10);
    store.set("alive", "y");
    saveSnapshot(store, path);

    const fresh = freshStore(t + 11_000);
    expect(loadSnapshot(fresh, path)).toBe(1);
    expect(fresh.get("dead")).toBeNull();
    expect(fresh.size).toBe(1);
  });

  it("restored TTL keys are tracked by the sweeper", () => {
    store.set("k", "v", 10);
    saveSnapshot(store, path);

    let now = t;
    const fresh = new Store(() => now);
    loadSnapshot(fresh, path);
    now += 11_000;
    fresh.sweep(); // never read the key: only the sweeper can remove it
    expect(fresh.size).toBe(0);
  });

  it("missing file returns 0 without error", () => {
    expect(loadSnapshot(freshStore(), join(dir, "nope.json"))).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("garbage file returns 0 and does not throw", () => {
    writeFileSync(path, "this is not json {{{");
    const fresh = freshStore();
    expect(() => loadSnapshot(fresh, path)).not.toThrow();
    expect(loadSnapshot(fresh, path)).toBe(0);
    expect(fresh.size).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it.each([
    ["empty object", "{}"],
    ["wrong version", JSON.stringify({ version: 2, entries: [] })],
    ["entries not an array", JSON.stringify({ version: 1, entries: "x" })],
    ["json null", "null"],
    ["json array", "[]"],
  ])("rejects unrecognised format: %s", (_name, body) => {
    writeFileSync(path, body);
    const fresh = freshStore();
    expect(loadSnapshot(fresh, path)).toBe(0);
    expect(fresh.size).toBe(0);
  });

  it("skips malformed entries but loads the valid ones", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        savedAt: 0,
        entries: [
          { key: 1, value: "bad-key", expiresAt: null },
          { key: "no-value", expiresAt: null },
          { key: "good", value: "ok", expiresAt: null },
        ],
      })
    );
    const fresh = freshStore();
    expect(loadSnapshot(fresh, path)).toBe(1);
    expect(fresh.get("good")).toBe("ok");
  });
});

describe("Store.restore", () => {
  it("returns false and inserts nothing for an expired entry", () => {
    const s = new Store(() => 1000);
    expect(s.restore("k", "v", 999)).toBe(false);
    expect(s.size).toBe(0);
  });

  it("returns true and inserts a live entry", () => {
    const s = new Store(() => 1000);
    expect(s.restore("k", "v", 5000)).toBe(true);
    expect(s.get("k")).toBe("v");
  });
});

describe("autosave", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "mini-redis-"));
    path = join(dir, "dump.json");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves on each tick", () => {
    const store = new Store();
    store.set("a", "1");
    const stop = startAutoSave(store, 1000, path);

    expect(existsSync(path)).toBe(false); // nothing before the first tick
    vi.advanceTimersByTime(1000);
    expect(existsSync(path)).toBe(true);
    stop();
  });

  it("stop function halts further saves", () => {
    const store = new Store();
    store.set("a", "1");
    const stop = startAutoSave(store, 1000, path);
    vi.advanceTimersByTime(1000);
    stop();

    store.set("b", "2");
    vi.advanceTimersByTime(5000);
    const keys = JSON.parse(readFileSync(path, "utf8")).entries.map((e: any) => e.key);
    expect(keys).toEqual(["a"]); // "b" never saved
  });

  it("a failed save is logged, not thrown", () => {
    const store = new Store();
    const stop = startAutoSave(store, 1000, join(dir, "no-such-dir", "dump.json"));
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(console.error).toHaveBeenCalled();
    stop();
  });
});