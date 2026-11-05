import net from "net";
import { parseRESP, ParseResult } from "./resp";
import { Store } from "./store";
import { execute } from "./commands";
import { buildSnapshot, saveSnapshot, loadSnapshot } from "./persistence";
import { SnapshotScheduler } from "./snapshotScheduler";

const PORT = Number(process.env.PORT ?? 6379);
const DEBUG = Boolean(process.env.DEBUG);
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH ?? "./dump.json";

const store = new Store();

loadSnapshot(store, SNAPSHOT_PATH);

store.start();


const scheduler = new SnapshotScheduler<Store>({
  build: () => store,                                   
  write: async (s) => { saveSnapshot(s, SNAPSHOT_PATH); }, 
});
scheduler.start();
const WRITE_CMDS = new Set(["SET", "DEL", "EXPIRE"]);

function runCommand(args: string[]): string | Promise<string> | null {
  const name = args[0]?.toUpperCase();

  if (name === "BGSAVE") {
    if (scheduler.isSaving) return "-ERR Background save already in progress\r\n";
    scheduler.save().catch((e) => console.error("BGSAVE failed:", e));
    return "+Background saving started\r\n";
  }

  const reply = execute(store, args);

  if (WRITE_CMDS.has(name) && !reply.startsWith("-") && reply !== ":0\r\n") {
    scheduler.markDirty();
  }
  return reply;
}

function toArgs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const args: string[] = [];
  for (const v of value) {
    if (v === null || v === undefined) return null;
    args.push(Buffer.isBuffer(v) ? v.toString("utf8") : String(v));
  }
  return args;
}

const sockets = new Set<net.Socket>();

const server = net.createServer((socket) => {
  console.log("Client connected");
  sockets.add(socket);

  let buffer = Buffer.alloc(0);
  let closing = false;

  socket.on("data", (data: Buffer) => {
    if (closing) return;

    buffer = Buffer.concat([buffer, data]);

    while (buffer.length > 0) {
      let result: ParseResult;

      try {
        result = parseRESP(buffer);
      } catch (error) {
        console.error("Protocol error:", (error as Error).message);

        closing = true;
        buffer = Buffer.alloc(0);
        socket.end("-ERR protocol error\r\n");
        return;
      }

      if (result.consumed === 0) {
        break;
      }

      buffer = buffer.subarray(result.consumed);

      if (Array.isArray(result.value) && result.value.length === 0) {
        continue;
      }

      if (DEBUG) console.log("Parsed:", result.value);

      const args = toArgs(result.value);
      if (args === null) {
        socket.write("-ERR commands must be arrays of bulk strings\r\n");
        continue;
      }

      try {
        socket.write(runCommand(args) as string);
      } catch (error) {
        console.error("Command error:", error);
        socket.write("-ERR internal error\r\n");
      }
    }
  });

  socket.on("close", () => {
    sockets.delete(socket);
    console.log("Client disconnected");
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error.message);
  });
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use (is real Redis running?)`);
  } else {
    console.error("Server error:", error);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Mini Redis server running on port ${PORT}`);
});

// Graceful shutdown: SIGINT (Ctrl+C) and SIGTERM (docker stop, EC2)
let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return; // second Ctrl+C must not race a second save
  shuttingDown = true;
  console.log(`${sig} received, saving...`);

  server.close();                       // stop accepting
  sockets.forEach((s) => s.destroy());  // drop clients so close() can finish
  store.stop();                         // stop expiry sweep
  try {
    await scheduler.finalSave();        // waits for in-flight save, saves if dirty
  } catch (e) {
    console.error("Final save failed:", e);
    process.exit(1);
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));