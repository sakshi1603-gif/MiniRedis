
import { test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";

const PORT = 6391;
const TEST_PASSWORD = "test-secret-123";

const MAX_UNAUTH_BYTES = 64 * 1024;

let server: ChildProcess;

const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, ms));

/** Encode a command as a RESP array of bulk strings. */
function cmd(...args: string[]): string {
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

/** Send RESP commands over a real TCP socket. */
function send(
  payload: string,
  waitMs = 150
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let out = "";

    sock.on("data", (d) => {
      out += d.toString();
    });

    sock.on("error", reject);

    sock.on("connect", () => {
      sock.write(payload);
    });

    setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, waitMs);
  });
}

beforeAll(async () => {
  const tsxCli = path.join(
    process.cwd(),
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs"
  );

  server = spawn(
    process.execPath,
    [tsxCli, "src/server.ts"],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        REDIS_PASSWORD: TEST_PASSWORD,
      },
      stdio: "inherit",
    }
  );

  // Wait until the server accepts connections.
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise<boolean>((res) => {
      const s = net.connect(PORT, "127.0.0.1");

      s.on("connect", () => {
        s.destroy();
        res(true);
      });

      s.on("error", () => res(false));
    });

    if (ok) return;

    await sleep(100);
  }

  throw new Error("server did not start");
});

afterAll(() => {
  server.kill();
});

// Helper: authenticate and execute commands on the same connection.
function sendAuthenticated(
  ...commands: string[]
): Promise<string> {
  return send(
    cmd("AUTH", TEST_PASSWORD) +
      commands
        .map((command) =>
          cmd(...command.split(" "))
        )
        .join("")
  );
}

// Authentication tests

test("commands are blocked before authentication", async () => {
  assert.equal(
    await send(cmd("PING")),
    "-NOAUTH Authentication required.\r\n"
  );

  assert.equal(
    await send(cmd("SET", "blocked", "value")),
    "-NOAUTH Authentication required.\r\n"
  );
});

test("wrong password is rejected", async () => {
  assert.equal(
    await send(cmd("AUTH", "wrong-password")),
    "-ERR invalid password\r\n"
  );
});

test("correct password authenticates the client", async () => {
  assert.equal(
    await sendAuthenticated("PING"),
    "+OK\r\n+PONG\r\n"
  );
});

test("authenticated client can execute SET and GET", async () => {
  assert.equal(
    await sendAuthenticated(
      "SET auth-key hello",
      "GET auth-key"
    ),
    "+OK\r\n+OK\r\n$5\r\nhello\r\n"
  );
});

test("each TCP connection must authenticate independently", async () => {
  // First connection authenticates successfully.
  assert.equal(
    await send(cmd("AUTH", TEST_PASSWORD)),
    "+OK\r\n"
  );

  // A new connection must authenticate separately.
  assert.equal(
    await send(cmd("PING")),
    "-NOAUTH Authentication required.\r\n"
  );
});

// Pre-authentication security tests

test("unauthenticated bulk strings larger than 64 KiB are rejected", async () => {
  // Declare a bulk string larger than the unauthenticated limit.
  // Send only its header, so the buffer itself remains small.
  const payload =
    "*3\r\n" +
    "$3\r\nSET\r\n" +
    "$1\r\nk\r\n" +
    `$${MAX_UNAUTH_BYTES + 1}\r\n`;

  const reply = await send(payload);

  assert.equal(
    reply,
    "-ERR protocol error\r\n"
  );
});

test("unauthenticated input buffer exceeding 64 KiB is rejected", async () => {
  // Declare a valid 64 KiB bulk string, but send an incomplete body
  // that makes the total incoming data exceed the buffer limit.
  const payload =
    "*1\r\n" +
    `$${MAX_UNAUTH_BYTES}\r\n` +
    "x".repeat(MAX_UNAUTH_BYTES + 1);

  const reply = await send(payload);

  assert.equal(
    reply,
    "-ERR unauthenticated input limit exceeded\r\n"
  );
});

test("authenticated clients can send bulk strings larger than 64 KiB", async () => {
  const largeValue = "x".repeat(
    MAX_UNAUTH_BYTES + 1
  );

  const reply = await new Promise<string>(
    (resolve, reject) => {
      const sock = net.connect(PORT, "127.0.0.1");
      let out = "";
      let authSent = false;

      sock.on("data", (data) => {
        out += data.toString();

        // Send the large command only after AUTH succeeds.
        if (
          !authSent &&
          out.includes("+OK\r\n")
        ) {
          authSent = true;

          sock.write(
            cmd("SET", "large-auth-value", largeValue)
          );
        }
      });

      sock.on("error", reject);

      sock.on("connect", () => {
        sock.write(
          cmd("AUTH", TEST_PASSWORD)
        );
      });

      setTimeout(() => {
        sock.destroy();
        resolve(out);
      }, 300);
    }
  );

  assert.equal(
    reply,
    "+OK\r\n+OK\r\n"
  );
});

// Existing functionality tests

test("PING / SET / GET over real TCP", async () => {
  assert.equal(
    await sendAuthenticated("PING"),
    "+OK\r\n+PONG\r\n"
  );

  assert.equal(
    await sendAuthenticated("SET foo bar"),
    "+OK\r\n+OK\r\n"
  );

  assert.equal(
    await sendAuthenticated("GET foo"),
    "+OK\r\n$3\r\nbar\r\n"
  );

  assert.equal(
    await sendAuthenticated("GET missing"),
    "+OK\r\n$-1\r\n"
  );
});

test("pipelining: several commands in one write, replies in order", async () => {
  const reply = await send(
    cmd("AUTH", TEST_PASSWORD) +
      cmd("SET", "p", "1") +
      cmd("GET", "p") +
      cmd("DEL", "p")
  );

  assert.equal(
    reply,
    "+OK\r\n+OK\r\n$1\r\n1\r\n:1\r\n"
  );
});

test("a command split across two TCP writes is reassembled", async () => {
  const full =
    cmd("AUTH", TEST_PASSWORD) +
    cmd("SET", "split", "value");

  const reply = await new Promise<string>(
    (resolve) => {
      const sock = net.connect(PORT, "127.0.0.1");
      let out = "";

      sock.on("data", (d) => {
        out += d.toString();
      });

      sock.on("connect", () => {
        sock.write(full.slice(0, 10));

        setTimeout(() => {
          sock.write(full.slice(10));
        }, 50);
      });

      setTimeout(() => {
        sock.destroy();
        resolve(out);
      }, 250);
    }
  );

  assert.equal(
    reply,
    "+OK\r\n+OK\r\n"
  );
});

test("expiry end to end: key disappears after TTL", async () => {
  await sendAuthenticated("SET temp x EX 1");

  assert.equal(
    await sendAuthenticated("TTL temp"),
    "+OK\r\n:1\r\n"
  );

  await sleep(1100);

  assert.equal(
    await sendAuthenticated("GET temp"),
    "+OK\r\n$-1\r\n"
  );

  assert.equal(
    await sendAuthenticated("TTL temp"),
    "+OK\r\n:-2\r\n"
  );
});

test("shared state across authenticated connections", async () => {
  await sendAuthenticated("SET shared yes");

  assert.equal(
    await sendAuthenticated("EXISTS shared"),
    "+OK\r\n:1\r\n"
  );
});

test("bad protocol closes the connection with an error", async () => {
  const reply = await send("*1\r\n$abc\r\n");

  assert.match(
    reply,
    /^-ERR protocol error/
  );
});
