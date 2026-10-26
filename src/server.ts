import net from "net";
import { parseRESP, ParseResult } from "./resp";
import { Store } from "./store";
import { execute } from "./commands";

const PORT = Number(process.env.PORT ?? 6379);
const DEBUG = Boolean(process.env.DEBUG);

const store = new Store();
store.start();

function toArgs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const args: string[] = [];
  for (const v of value) {
    if (v === null || v === undefined) return null;
    args.push(Buffer.isBuffer(v) ? v.toString("utf8") : String(v));
  }
  return args;
}

const server = net.createServer((socket) => {
  console.log("Client connected");

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
        socket.write(execute(store, args));
      } catch (error) {
        console.error("Command error:", error);
        socket.write("-ERR internal error\r\n");
      }
    }
  });

  socket.on("close", () => {
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

// Clean shutdown on Ctrl+C
process.on("SIGINT", () => {
  store.stop();
  server.close();
  process.exit(0);
});