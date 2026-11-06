// Jest, or Vitest with `globals: true`. If your runner needs imports, add:
// import { describe, it, expect } from "vitest";
import { describe, it, expect } from "vitest";
import { SnapshotScheduler } from "./snapshotScheduler";
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("SnapshotScheduler", () => {
  it("markDirty increments and a successful save resets to 0", async () => {
    const s = new SnapshotScheduler({ build: () => ({}), write: async () => {} });
    s.markDirty(); s.markDirty();
    expect(s.dirtyCount).toBe(2);
    await s.save();
    expect(s.dirtyCount).toBe(0);
  });

  it("keeps writes that arrive DURING a save in the dirty count", async () => {
    const d = deferred();
    const s = new SnapshotScheduler({ build: () => ({}), write: () => d.promise });
    s.markDirty();
    const p = s.save();
    s.markDirty();           // arrives while the file write is in flight
    d.resolve();
    await p;
    expect(s.dirtyCount).toBe(1);
  });

  it("does not run two saves at once", async () => {
    const d = deferred();
    const s = new SnapshotScheduler({ build: () => ({}), write: () => d.promise });
    const first = s.save();
    expect(await s.save()).toBe(false);
    d.resolve();
    expect(await first).toBe(true);
  });

  it("failed write keeps dirty count and releases the lock", async () => {
    let fail = true;
    const s = new SnapshotScheduler({
      build: () => ({}),
      write: async () => { if (fail) throw new Error("disk full"); },
    });
    s.markDirty();
    await expect(s.save()).rejects.toThrow("disk full");
    expect(s.dirtyCount).toBe(1);
    expect(s.isSaving).toBe(false);
    fail = false;
    expect(await s.save()).toBe(true);
    expect(s.dirtyCount).toBe(0);
  });

  it("checkRules respects seconds + changes thresholds", async () => {
    let t = 0;
    let writes = 0;
    const s = new SnapshotScheduler(
      { build: () => ({}), write: async () => { writes++; } },
      { rules: [[60, 1], [10, 100]], now: () => t },
    );
    s.markDirty();
    t = 30_000; s.checkRules(); await Promise.resolve();
    expect(writes).toBe(0);                 // 1 change, only 30s
    t = 61_000; s.checkRules(); await new Promise((r) => setImmediate(r));
    expect(writes).toBe(1);                 // 60s rule fired
    s.markDirty(100);
    t = 72_000; s.checkRules(); await new Promise((r) => setImmediate(r));
    expect(writes).toBe(2);                 // 100 changes in >=10s fired
  });

  it("finalSave skips when clean, saves when dirty, waits for in-flight save", async () => {
    let writes = 0;
    const d = deferred();
    let blockFirst = true;
    const s = new SnapshotScheduler({
      build: () => ({}),
      write: async () => { writes++; if (blockFirst) { blockFirst = false; await d.promise; } },
    });

    await s.finalSave();
    expect(writes).toBe(0);                 // clean: nothing to do

    s.markDirty();
    const inflight = s.save();              // blocked on d
    s.markDirty();                          // dirty again during save
    const fin = s.finalSave();              // must wait, then save again
    d.resolve();
    await inflight; await fin;
    expect(writes).toBe(2);
    expect(s.dirtyCount).toBe(0);
  });
});
