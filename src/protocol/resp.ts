export type RespValue =
  | string
  | number
  | null
  | RespValue[];

export interface ParseResult {
  value: RespValue | null;
  consumed: number; // 0 means "incomplete, wait for more bytes"
}

const CRLF = "\r\n";

// Limits: without these, one client can make the server buffer forever.
const MAX_LINE_LEN = 64 * 1024;          // simple strings / errors / headers
const MAX_BULK_LEN = 64 * 1024 * 1024;   // real Redis allows 512 MB
const MAX_ARRAY_LEN = 1024 * 1024;       // max elements in one array
const MAX_DEPTH = 32;                    // nested arrays, protects the call stack

const INCOMPLETE: ParseResult = { value: null, consumed: 0 };

/**
 * Strict integer parsing. parseInt("3abc") returns 3 and parseInt("abc")
 * returns NaN, both of which silently corrupt parsing. Reject them instead.
 */
function parseIntStrict(buffer: Buffer, start: number, end: number): number {
  const text = buffer.toString("utf8", start, end);

  if (!/^-?\d+$/.test(text)) {
    throw new Error(`Invalid integer: ${JSON.stringify(text)}`);
  }

  const n = Number(text);

  if (!Number.isSafeInteger(n)) {
    throw new Error("Integer out of range");
  }

  return n;
}

/** Index of the first CRLF, or -1 if the line isn't complete yet. */
function findLineEnd(buffer: Buffer): number {
  const end = buffer.indexOf(CRLF);

  if (end === -1) {
    if (buffer.length > MAX_LINE_LEN) throw new Error("Line too long");
    return -1;
  }

  if (end > MAX_LINE_LEN) throw new Error("Line too long");

  return end;
}

export function parseRESP(buffer: Buffer, depth = 0): ParseResult {
  if (depth > MAX_DEPTH) {
    throw new Error("Nesting too deep");
  }

  if (buffer.length === 0) {
    return INCOMPLETE;
  }

  const type = String.fromCharCode(buffer[0]);

  if (!"+-:$*".includes(type)) {
    throw new Error(`Unknown RESP type: ${JSON.stringify(type)}`);
  }

  // Every RESP type starts with a line ending in CRLF
  const lineEnd = findLineEnd(buffer);

  if (lineEnd === -1) {
    return INCOMPLETE;
  }

  const afterLine = lineEnd + 2;

  switch (type) {
    // Simple String
    case "+":
      return {
        value: buffer.toString("utf8", 1, lineEnd),
        consumed: afterLine
      };

    // Error
    case "-":
      return {
        value: `ERROR: ${buffer.toString("utf8", 1, lineEnd)}`,
        consumed: afterLine
      };

    // Integer
    case ":":
      return {
        value: parseIntStrict(buffer, 1, lineEnd),
        consumed: afterLine
      };

    // Bulk String
    case "$": {
      const length = parseIntStrict(buffer, 1, lineEnd);

      // Null bulk string
      if (length === -1) {
        return { value: null, consumed: afterLine };
      }

      if (length < 0 || length > MAX_BULK_LEN) {
        throw new Error("Invalid bulk string length");
      }

      const dataEnd = afterLine + length;

      // Body + trailing CRLF haven't fully arrived yet
      if (buffer.length < dataEnd + 2) {
        return INCOMPLETE;
      }

      if (buffer[dataEnd] !== 13 || buffer[dataEnd + 1] !== 10) {
        throw new Error("Invalid RESP bulk string");
      }

      return {
        value: buffer.toString("utf8", afterLine, dataEnd),
        consumed: dataEnd + 2
      };
    }

    // Array
    case "*": {
      const count = parseIntStrict(buffer, 1, lineEnd);

      // Null array
      if (count === -1) {
        return { value: null, consumed: afterLine };
      }

      if (count < 0 || count > MAX_ARRAY_LEN) {
        throw new Error("Invalid array length");
      }

      let offset = afterLine;
      const values: RespValue[] = [];

      for (let i = 0; i < count; i++) {
        const result = parseRESP(buffer.subarray(offset), depth + 1);

        // An element is incomplete, so the whole array is incomplete
        if (result.consumed === 0) {
          return INCOMPLETE;
        }

        values.push(result.value);
        offset += result.consumed;
      }

      return { value: values, consumed: offset };
    }
  }

  // Unreachable, but keeps TypeScript happy
  throw new Error("Unreachable");
}