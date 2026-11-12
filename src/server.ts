
import net from "net";
import { createHash, timingSafeEqual } from "crypto";

import {
  parseRESP,
  ParseResult
} from "./protocol/resp";

import { Store } from "./store/store";

import { execute } from "./commands/commands";

import {
  saveSnapshot,
  loadSnapshot
} from "./persistence/persistence";

import { SnapshotScheduler } from "./persistence/snapshotScheduler";

import { parseMemory } from "./store/memory-manager";

const PORT = Number(process.env.PORT ?? 6379);
const DEBUG = Boolean(process.env.DEBUG);
const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ?? "./dump.json";

// Authentication input limits
const MAX_UNAUTH_BUFFER_BYTES = 64 * 1024;
const MAX_UNAUTH_BULK_BYTES = 64 * 1024;
const MAX_AUTH_BULK_BYTES = 64 * 1024 * 1024;

// Authentication configuration
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

if (!REDIS_PASSWORD || REDIS_PASSWORD.length === 0) {
  console.error(
    "REDIS_PASSWORD environment variable is required"
  );

  process.exit(1);
}

// Store the SHA-256 digest instead of the original password.
const EXPECTED_PASSWORD = createHash("sha256")
  .update(REDIS_PASSWORD, "utf8")
  .digest();

// MAXMEMORY=100mb. Unset or 0 = unlimited.
const MAXMEMORY_BYTES = parseMemory(
  process.env.MAXMEMORY
);

const store = new Store(
  Date.now,
  MAXMEMORY_BYTES
);

loadSnapshot(store, SNAPSHOT_PATH);

store.start();

const scheduler = new SnapshotScheduler<Store>({
  build: () => store,

  write: async (s) => {
    saveSnapshot(s, SNAPSHOT_PATH);
  }
});

scheduler.start();

const WRITE_CMDS = new Set([
  "SET",
  "DEL",
  "EXPIRE"
]);

// Compare fixed-length SHA-256 digests.
function authenticate(password: string): boolean {
  const receivedPassword = createHash("sha256")
    .update(password, "utf8")
    .digest();

  return timingSafeEqual(
    receivedPassword,
    EXPECTED_PASSWORD
  );
}

function runCommand(args: string[]): string {
  const name = args[0]?.toUpperCase();

  if (name === "BGSAVE") {
    if (scheduler.isSaving) {
      return "-ERR Background save already in progress\r\n";
    }

    scheduler.save().catch((e) => {
      console.error("BGSAVE failed:", e);
    });

    return "+Background saving started\r\n";
  }

  // Use the same snapshot path for SAVE as automatic persistence.
  const reply = execute(
    store,
    args,
    SNAPSHOT_PATH
  );

  if (
    WRITE_CMDS.has(name) &&
    !reply.startsWith("-") &&
    reply !== ":0\r\n"
  ) {
    scheduler.markDirty();
  }

  return reply;
}

function toArgs(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const args: string[] = [];

  for (const v of value) {
    if (v === null || v === undefined) {
      return null;
    }

    args.push(
      Buffer.isBuffer(v)
        ? v.toString("utf8")
        : String(v)
    );
  }

  return args;
}

const sockets = new Set<net.Socket>();

const server = net.createServer((socket) => {
  console.log("Client connected");

  sockets.add(socket);

  let buffer = Buffer.alloc(0);
  let closing = false;

  // Authentication belongs to this individual connection.
  let authenticated = false;

  socket.on("data", (data: Buffer) => {
    if (closing) return;

    // Protect the server from excessive unauthenticated input.
    if (
      !authenticated &&
      buffer.length + data.length >
        MAX_UNAUTH_BUFFER_BYTES
    ) {
      closing = true;
      buffer = Buffer.alloc(0);

      socket.end(
        "-ERR unauthenticated input limit exceeded\r\n"
      );

      return;
    }

    buffer = Buffer.concat([
      buffer,
      data
    ]);

    while (buffer.length > 0) {
      let result: ParseResult;

      try {
        // Before AUTH: 64 KiB bulk-string limit.
        // After AUTH: 64 MiB bulk-string limit.
        result = parseRESP(
          buffer,
          0,
          authenticated
            ? MAX_AUTH_BULK_BYTES
            : MAX_UNAUTH_BULK_BYTES
        );
      } catch (error) {
        console.error(
          "Protocol error:",
          (error as Error).message
        );

        closing = true;
        buffer = Buffer.alloc(0);

        socket.end(
          "-ERR protocol error\r\n"
        );

        return;
      }

      if (result.consumed === 0) {
        break;
      }

      buffer = buffer.subarray(
        result.consumed
      );

      if (
        Array.isArray(result.value) &&
        result.value.length === 0
      ) {
        continue;
      }

      if (DEBUG) {
        console.log("Parsed:", result.value);
      }

      const args = toArgs(result.value);

      if (
        args === null ||
        args.length === 0
      ) {
        socket.write(
          "-ERR commands must be arrays of bulk strings\r\n"
        );

        continue;
      }

      const command = args[0].toUpperCase();

      // AUTH command
      if (command === "AUTH") {
        if (args.length !== 2) {
          socket.write(
            "-ERR wrong number of arguments for 'auth' command\r\n"
          );

          continue;
        }

        if (authenticate(args[1])) {
          authenticated = true;
          socket.write("+OK\r\n");
        } else {
          socket.write(
            "-ERR invalid password\r\n"
          );
        }

        continue;
      }

      // Block commands until authentication succeeds.
      if (!authenticated) {
        socket.write(
          "-NOAUTH Authentication required.\r\n"
        );

        continue;
      }

      try {
        socket.write(
          runCommand(args)
        );
      } catch (error) {
        console.error(
          "Command error:",
          error
        );

        socket.write(
          "-ERR internal error\r\n"
        );
      }
    }
  });

  socket.on("close", () => {
    sockets.delete(socket);
    console.log("Client disconnected");
  });

  socket.on("error", (error) => {
    console.error(
      "Socket error:",
      error.message
    );
  });
});

server.on(
  "error",
  (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use (is real Redis running?)`
      );
    } else {
      console.error("Server error:", error);
    }

    process.exit(1);
  }
);

server.listen(PORT, () => {
  console.log(
    `Mini Redis server running on port ${PORT}`
  );

  console.log(
    MAXMEMORY_BYTES === 0
      ? "maxmemory: unlimited (no eviction)"
      : `maxmemory: ${MAXMEMORY_BYTES} bytes (allkeys-lru)`
  );

  console.log("Authentication: enabled");
});

// Graceful shutdown: SIGINT and SIGTERM
let shuttingDown = false;

async function shutdown(sig: string) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(
    `${sig} received, saving...`
  );

  server.close();

  sockets.forEach((s) => s.destroy());

  store.stop();

  try {
    await scheduler.finalSave();
  } catch (e) {
    console.error(
      "Final save failed:",
      e
    );

    process.exit(1);
  }

  process.exit(0);
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);
