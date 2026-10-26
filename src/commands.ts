import { Store } from "./store";
import * as enc from "./encode";

const INT = /^-?\d+$/;

const arity = (cmd: string): string =>
  enc.error(`ERR wrong number of arguments for '${cmd.toLowerCase()}' command`);

export function execute(store: Store, args: string[]): string {
  if (args.length === 0) return enc.error("ERR empty command");
  const cmd = args[0].toUpperCase();
  const a = args.slice(1);

  switch (cmd) {
    case "PING":
      return a.length ? enc.bulk(a[0]) : enc.simple("PONG");

    case "SET": {
      // SET key value  |  SET key value EX seconds
      if (a.length !== 2 && a.length !== 4) return arity(cmd);
      if (a.length === 4) {
        if (a[2].toUpperCase() !== "EX") return enc.error("ERR syntax error");
        if (!INT.test(a[3]) || Number(a[3]) <= 0)
          return enc.error("ERR invalid expire time in 'set' command");
        store.set(a[0], a[1], Number(a[3]));
      } else {
        store.set(a[0], a[1]);
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

    default:
      return enc.error(`ERR unknown command '${args[0]}'`);
  }
}