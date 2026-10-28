import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";
import { saveSnapshot, Snapshot } from "./persistence";
import { execute } from "./commands";

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
