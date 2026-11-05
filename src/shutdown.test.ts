// E2E: graceful SIGTERM keeps data, kill -9 before any autosave loses it.
// Run from the mini-redis/ folder:  npx vitest run src/shutdown.test.ts
// Needs tsx installed:              npm i -D tsx
import { spawn, ChildProcess } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- CONFIG ----
const PORT = 6399; // must differ from e2e.test.ts (6391); vitest runs files in parallel
const ROOT = path.resolve(__dirname, ".."); // mini-redis/
const envFor = (snapshotPath: string) => ({
  PORT: String(PORT),
  SNAPSHOT_PATH: snapshotPath,
});
// ----------------

function resp(...args: string[]) {
  return `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("");
}

function send(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1", () => sock.write(resp(...args)));
    sock.once("data", (d) => { resolve(d.toString()); sock.end(); });
    sock.once("error", reject);
  });
}

async function waitUp(timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { await send("PING"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
}

const children: ChildProcess[] = [];

function startServer(snapshotPath: string): ChildProcess {
  // process.execPath + --import tsx: no npx, works on Windows, cwd pinned to project root
  const p = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, ...envFor(snapshotPath) },
    stdio: "ignore",
  });
  children.push(p);
  return p;
}

function exited(p: ChildProcess) {
  return new Promise<void>((r) => p.once("exit", () => r()));
}

describe("persistence across shutdown", () => {
  let dir: string;
  let snap: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-redis-"));
    snap = path.join(dir, "dump.json");
  });

  afterEach(() => {
    // never leave orphan servers holding the port if a test fails midway
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // On Windows, kill("SIGTERM") hard-kills the process, so the handler never runs.
  // Run this one in WSL / Docker / Linux.
  it.skipIf(process.platform === "win32")("SIGTERM saves, data survives restart", async () => {
    const a = startServer(snap);
    await waitUp();
    await send("SET", "k", "v");
    a.kill("SIGTERM");
    await exited(a);

    const b = startServer(snap);
    await waitUp();
    expect(await send("GET", "k")).toContain("v");
    b.kill("SIGTERM");
    await exited(b);
  }, 30_000);

  it("kill -9 before any autosave loses unsaved data", async () => {
    const a = startServer(snap);
    await waitUp();
    await send("SET", "k", "v");
    a.kill("SIGKILL");
    await exited(a);

    const b = startServer(snap);
    await waitUp();
    expect(await send("GET", "k")).toContain("$-1"); // nil
    b.kill("SIGKILL");
    await exited(b);
  }, 30_000);
});