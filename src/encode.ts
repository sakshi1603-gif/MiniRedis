// RESP reply encoders.
const CRLF = "\r\n";

export const simple = (s: string): string => `+${s}${CRLF}`;
export const error = (s: string): string => `-${s}${CRLF}`;
export const integer = (n: number): string => `:${n}${CRLF}`;

export const bulk = (s: string | null): string =>
  s === null ? `$-1${CRLF}` : `$${Buffer.byteLength(s)}${CRLF}${s}${CRLF}`;