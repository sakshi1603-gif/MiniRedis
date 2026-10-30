import { writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
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

// ───────────────────────── DAY 7 ─────────────────────────

/** Loads a snapshot into the store. Returns number of keys loaded.
 *  Never throws: a missing or bad file means "start empty". */
export function loadSnapshot(
  store: Store,
  path: string = DEFAULT_SNAPSHOT_PATH
): number {
  if (!existsSync(path)) return 0; // first run: normal, not an error

  let snap: Snapshot;
  try {
    snap = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[persistence] cannot parse ${path}, starting empty:`, err);
    return 0;
  }

  if (!snap || snap.version !== 1 || !Array.isArray(snap.entries)) {
    console.error(`[persistence] unrecognised snapshot format, starting empty`);
    return 0;
  }

  let loaded = 0;
  for (const e of snap.entries) {
    if (typeof e?.key !== "string" || typeof e?.value !== "string") continue;
    const exp = typeof e.expiresAt === "number" ? e.expiresAt : null;
    if (store.restore(e.key, e.value, exp)) loaded++; // restore skips expired
  }
  return loaded;
}

/** Saves every intervalMs. Returns a function that stops the timer. */
export function startAutoSave(
  store: Store,
  intervalMs = 5000,
  path: string = DEFAULT_SNAPSHOT_PATH
): () => void {
  const timer = setInterval(() => {
    try {
      saveSnapshot(store, path);
    } catch (err) {
      console.error("[persistence] autosave failed:", err); // keep serving
    }
  }, intervalMs);
  timer.unref(); // the timer alone must not keep the process alive
  return () => clearInterval(timer);
}
