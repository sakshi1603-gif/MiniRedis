
import { spawn, ChildProcess } from "node:child_process";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- CONFIG ----
const PORT = 6399;
const TEST_PASSWORD = "test-secret-123";

const ROOT = path.resolve(__dirname, "..");

const envFor = (snapshotPath: string) => ({
  PORT: String(PORT),
  SNAPSHOT_PATH: snapshotPath,
  REDIS_PASSWORD: TEST_PASSWORD,
});
// ----------------

function resp(...args: string[]) {
  return (
    `*${args.length}\r\n` +
    args
      .map(
        (a) =>
          `$${Buffer.byteLength(a)}\r\n${a}\r\n`
      )
      .join("")
  );
}

// Every connection authenticates before executing its command.
function send(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let output = "";
    let responseCount = 0;

    sock.on("connect", () => {
      sock.write(
        resp("AUTH", TEST_PASSWORD) +
        resp(...args)
      );
    });

    sock.on("data", (data) => {
      output += data.toString();

      // AUTH response + command response.
      // Each response in these tests ends with CRLF.
      responseCount += (data.toString().match(/\r\n/g) ?? []).length;

      if (responseCount >= 2) {
        sock.end();
        resolve(output);
      }
    });

    sock.on("error", reject);
  });
}

async function waitUp(timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    try {
      await send("PING");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  throw new Error("server did not start");
}

const children: ChildProcess[] = [];

function startServer(snapshotPath: string): ChildProcess {
  const p = spawn(
    process.execPath,
    ["--import", "tsx", "src/server.ts"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...envFor(snapshotPath),
      },
      stdio: "ignore",
    }
  );

  children.push(p);

  return p;
}

function exited(p: ChildProcess) {
  return new Promise<void>((resolve) => {
    p.once("exit", () => resolve());
  });
}

describe("persistence across shutdown", () => {
  let dir: string;
  let snap: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mini-redis-")
    );

    snap = path.join(dir, "dump.json");
  });

  afterEach(() => {
    // Never leave orphan servers holding the port.
    for (const c of children.splice(0)) {
      if (c.exitCode === null) {
        c.kill("SIGKILL");
      }
    }

    fs.rmSync(dir, {
      recursive: true,
      force: true,
    });
  });

  // On Windows, SIGTERM does not execute the graceful
  // shutdown handler in the same way as Linux.
  it.skipIf(process.platform === "win32")(
    "SIGTERM saves, data survives restart",
    async () => {
      const a = startServer(snap);

      await waitUp();

      const setReply = await send("SET", "k", "v");
      expect(setReply).toContain("+OK\r\n");

      a.kill("SIGTERM");
      await exited(a);

      const b = startServer(snap);

      await waitUp();

      const getReply = await send("GET", "k");
      expect(getReply).toContain("v");

      b.kill("SIGTERM");
      await exited(b);
    },
    30_000
  );

  it(
    "kill -9 before any autosave loses unsaved data",
    async () => {
      const a = startServer(snap);

      await waitUp();

      const setReply = await send("SET", "k", "v");
      expect(setReply).toContain("+OK\r\n");

      a.kill("SIGKILL");
      await exited(a);

      const b = startServer(snap);

      await waitUp();

      const getReply = await send("GET", "k");
      expect(getReply).toContain("$-1");

      b.kill("SIGKILL");
      await exited(b);
    },
    30_000
  );
});
