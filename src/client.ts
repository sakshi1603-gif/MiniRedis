import net from "net";

const HOST = "localhost";
const PORT = 6379;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build a RESP command. Buffer.byteLength, not .length, so UTF-8 works. */
function encode(...args: string[]): string {
  let out = `*${args.length}\r\n`;

  for (const arg of args) {
    out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  }

  return out;
}

interface TestCase {
  name: string;
  chunks: string[];       // each chunk is a separate socket.write()
  expectReplies: number;  // how many reply lines we expect back
  expectError?: boolean;  // expect "-ERR" and the server closing the socket
}

function runTest(test: TestCase): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: PORT, host: HOST });
    let received = "";
    let serverClosed = false;

    socket.on("data", (d) => {
      received += d.toString();
    });

    socket.on("error", (e) => {
      console.error(`  socket error: ${e.message}`);
    });

    socket.on("end", () => {
      serverClosed = true; // server sent FIN
    });

    socket.on("close", () => {
      const replies = (received.match(/\r\n/g) ?? []).length;

      const pass = test.expectError
        ? received.startsWith("-ERR") && serverClosed
        : replies === test.expectReplies && !received.includes("-ERR");

      console.log(
        `${pass ? "PASS" : "FAIL"}  ${test.name}` +
          `  (replies: ${replies}, got: ${JSON.stringify(received)})`
      );

      resolve(pass);
    });

    socket.on("connect", async () => {
      for (const chunk of test.chunks) {
        socket.write(chunk);
        await sleep(100); // force the server to see separate "data" events
      }

      await sleep(200);
      socket.end();
    });
  });
}

async function main() {
  const set = encode("SET", "name", "Sakshi");

  // Split in the middle of a CRLF (between \r and \n)
  const crlfSplit = set.indexOf("\r") + 1;

  // Split in the middle of a bulk string body ("Sak" | "shi")
  const bodySplit = set.indexOf("Sakshi") + 3;

  const tests: TestCase[] = [
    {
      name: "single command",
      chunks: [set],
      expectReplies: 1
    },
    {
      name: "split inside CRLF",
      chunks: [set.slice(0, crlfSplit), set.slice(crlfSplit)],
      expectReplies: 1
    },
    {
      name: "split inside bulk body",
      chunks: [set.slice(0, bodySplit), set.slice(bodySplit)],
      expectReplies: 1
    },
    {
      name: "two commands in one write (pipelined)",
      chunks: [set + set],
      expectReplies: 2
    },
    {
      name: "one and a half commands, then the rest",
      chunks: [set + set.slice(0, 10), set.slice(10)],
      expectReplies: 2
    },
    {
      name: "UTF-8 value",
      chunks: [encode("SET", "greeting", "नमस्ते")],
      expectReplies: 1
    },
    {
      name: "bad bulk length",
      chunks: ["*2\r\n$abc\r\n"],
      expectReplies: 1,
      expectError: true
    },
    {
      name: "absurd bulk length",
      chunks: ["*1\r\n$999999999999\r\n"],
      expectReplies: 1,
      expectError: true
    },
    {
      name: "unknown type byte",
      chunks: ["PING\r\n"],
      expectReplies: 1,
      expectError: true
    }
  ];

  let passed = 0;

  for (const test of tests) {
    if (await runTest(test)) passed++;
  }

  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
}

main();