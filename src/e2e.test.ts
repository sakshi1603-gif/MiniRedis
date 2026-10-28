/**
 * End-to-end test: boots the real server as a child process and talks RESP
 * over a real TCP socket, exactly like redis-cli would.
 * Run with:  npx tsx --test src/e2e.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";

const PORT = 6391;
let server: ChildProcess;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Encode a command as a RESP array of bulk strings. */
function cmd(...args: string[]): string {
  return (
    `*${args.length}\r\n` +
    args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")
  );
}

/** Send raw bytes, wait for `expectedLen` bytes of reply (or timeout). */
function send(payload: string, waitMs = 150): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let out = "";
    sock.on("data", (d) => (out += d.toString()));
    sock.on("error", reject);
    sock.on("connect", () => sock.write(payload));
    setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, waitMs);
  });
}

before(async () => {
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  server = spawn(process.execPath, [tsxCli, "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  // wait until the port accepts connections
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise<boolean>((res) => {
      const s = net.connect(PORT, "127.0.0.1");
      s.on("connect", () => { s.destroy(); res(true); });
      s.on("error", () => res(false));
    });
    if (ok) return;
    await sleep(100);
  }
  throw new Error("server did not start");
});

after(() => {
  server.kill();
});

test("PING / SET / GET over real TCP", async () => {
  assert.equal(await send(cmd("PING")), "+PONG\r\n");
  assert.equal(await send(cmd("SET", "foo", "bar")), "+OK\r\n");
  assert.equal(await send(cmd("GET", "foo")), "$3\r\nbar\r\n");
  assert.equal(await send(cmd("GET", "missing")), "$-1\r\n");
});

test("pipelining: several commands in one write, replies in order", async () => {
  const reply = await send(cmd("SET", "p", "1") + cmd("GET", "p") + cmd("DEL", "p"));
  assert.equal(reply, "+OK\r\n$1\r\n1\r\n:1\r\n");
});

test("a command split across two TCP writes is reassembled", async () => {
  const full = cmd("SET", "split", "value");
  const reply = await new Promise<string>((resolve) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let out = "";
    sock.on("data", (d) => (out += d.toString()));
    sock.on("connect", () => {
      sock.write(full.slice(0, 10));
      setTimeout(() => sock.write(full.slice(10)), 50);
    });
    setTimeout(() => { sock.destroy(); resolve(out); }, 250);
  });
  assert.equal(reply, "+OK\r\n");
});

test("expiry end to end: key disappears after TTL, both lazy and via TTL cmd", async () => {
  await send(cmd("SET", "temp", "x", "EX", "1"));
  assert.equal(await send(cmd("TTL", "temp")), ":1\r\n");
  await sleep(1100);
  assert.equal(await send(cmd("GET", "temp")), "$-1\r\n");
  assert.equal(await send(cmd("TTL", "temp")), ":-2\r\n");
});

test("shared state across connections", async () => {
  await send(cmd("SET", "shared", "yes"));
  assert.equal(await send(cmd("EXISTS", "shared")), ":1\r\n");
});

test("bad protocol closes the connection with an error", async () => {
  const reply = await send("*1\r\n$abc\r\n");
  assert.match(reply, /^-ERR protocol error/);
});