import { Store } from "./store";
import * as enc from "./encode";
import { saveSnapshot, DEFAULT_SNAPSHOT_PATH } from "./persistence";
import { OomError } from "./memory-manager";

const INT = /^-?\d+$/;

const arity = (cmd: string): string =>
  enc.error(`ERR wrong number of arguments for '${cmd.toLowerCase()}' command`);

function infoText(store: Store, section: string | undefined): string {
  const m = store.memoryStats();
  const memory = [
    "# Memory",
    `used_memory:${m.usedBytes}`,
    `maxmemory:${m.maxBytes}`,
    `maxmemory_policy:${m.maxBytes === 0 ? "noeviction" : "allkeys-lru"}`,
  ];
  const stats = ["# Stats", `evicted_keys:${m.evictedKeys}`, `keys:${store.size}`];

  const s = section?.toLowerCase();
  let lines: string[] = [];
  if (s === undefined || s === "all" || s === "default" || s === "everything") {
    lines = [...memory, "", ...stats];
  } else if (s === "memory") lines = memory;
  else if (s === "stats") lines = stats;
  return lines.join("\r\n") + "\r\n";
}

export function execute(
  store: Store,
  args: string[],
  snapshotPath: string = DEFAULT_SNAPSHOT_PATH
): string {
  if (args.length === 0) return enc.error("ERR empty command");
  const cmd = args[0].toUpperCase();
  const a = args.slice(1);

  switch (cmd) {
    case "PING":
      return a.length ? enc.bulk(a[0]) : enc.simple("PONG");

    case "SET": {
      if (a.length !== 2 && a.length !== 4) return arity(cmd);
      if (a.length === 4) {
        if (a[2].toUpperCase() !== "EX") return enc.error("ERR syntax error");
        if (!INT.test(a[3]) || Number(a[3]) <= 0)
          return enc.error("ERR invalid expire time in 'set' command");
      }
      try {
        if (a.length === 4) store.set(a[0], a[1], Number(a[3]));
        else store.set(a[0], a[1]);
      } catch (e) {
        if (e instanceof OomError) {
          return enc.error("OOM command not allowed: value larger than maxmemory");
        }
        throw e;
      }
      return enc.simple("OK");
    }

    case "GET":
      return a.length === 1 ? enc.bulk(store.get(a[0])) : arity(cmd);

    case "DEL":
      return a.length >= 1 ? enc.integer(store.del(a)) : arity(cmd);

    case "EXISTS":
      return a.length >= 1 ? enc.integer(store.exists(a)) : arity(cmd);

    case "EXPIRE": {
      if (a.length !== 2) return arity(cmd);
      if (!INT.test(a[1]))
        return enc.error("ERR value is not an integer or out of range");
      return enc.integer(store.expire(a[0], Number(a[1])));
    }

    case "TTL":
      return a.length === 1 ? enc.integer(store.ttl(a[0])) : arity(cmd);

    case "INFO":
      if (a.length > 1) return arity(cmd);
      return enc.bulk(infoText(store, a[0]));

    case "CONFIG": {
      if (a.length !== 2 || a[0].toUpperCase() !== "GET") return arity(cmd);
      if (a[1].toLowerCase() !== "maxmemory") return "*0\r\n";
      const max = String(store.memoryStats().maxBytes);
      return `*2\r\n${enc.bulk("maxmemory")}${enc.bulk(max)}`;
    }

    case "SAVE": {
      if (a.length !== 0) return arity(cmd);
      try {
        saveSnapshot(store, snapshotPath);
        return enc.simple("OK");
      } catch {
        return enc.error("ERR snapshot failed");
      }
    }

    default:
      return enc.error(`ERR unknown command '${args[0]}'`);
  }
}
