import net from "net";
import { parseRESP, ParseResult } from "./resp";

const PORT = 6379;

const server = net.createServer((socket) => {
  console.log("Client connected");

  let buffer = Buffer.alloc(0);
  let closing = false;

  socket.on("data", (data: Buffer) => {
    // After a protocol error we've already called end(); ignore late bytes
    if (closing) return;

    // Add newly received bytes
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length > 0) {
      let result: ParseResult;

      // Only the parser is inside try/catch. If command handling later
      // throws, that's a server bug, not a "protocol error".
      try {
        result = parseRESP(buffer);
      } catch (error) {
        console.error("Protocol error:", (error as Error).message);

        // The stream is out of sync: we can't know where the next command
        // starts. Reply, then close (this is what real Redis does).
        closing = true;
        buffer = Buffer.alloc(0);
        socket.end("-ERR protocol error\r\n");
        return;
      }

      // Command incomplete, wait for more bytes
      if (result.consumed === 0) {
        break;
      }

      // Remove consumed bytes
      buffer = buffer.subarray(result.consumed);

      // Real Redis silently ignores empty commands
      if (Array.isArray(result.value) && result.value.length === 0) {
        continue;
      }

      console.log("Parsed:", result.value);

      // Temporary response
      socket.write("+OK\r\n");
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