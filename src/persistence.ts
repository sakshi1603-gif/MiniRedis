import { writeFileSync, renameSync } from "node:fs";
import { Store } from "./store";

export const DEFAULT_SNAPSHOT_PATH = process.env.MINI_REDIS_DUMP ?? "dump.json";

export type SnapshotEntry = {
  key: string;
  value: string;
  expiresAt: number | null; // absolute epoch ms, NOT remaining TTL
};

export type Snapshot = {
  version: 1;
  savedAt: number;
  entries: SnapshotEntry[];
};

export function buildSnapshot(store: Store): Snapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    entries: [...store.liveEntries()],
  };
}

/** Writes snapshot atomically. Returns number of keys saved. */
export function saveSnapshot(
  store: Store,
  path: string = DEFAULT_SNAPSHOT_PATH
): number {
  const snap = buildSnapshot(store);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, path); // atomic replace on the same filesystem
  return snap.entries.length;
}
