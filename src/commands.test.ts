import { test } from "vitest";
import assert from "node:assert/strict";
import { Store } from "./store";
import { execute } from "./commands";

const run = (s: Store, ...args: string[]) => execute(s, args);

test("PING", () => {
  const s = new Store();
  assert.equal(run(s, "PING"), "+PONG\r\n");
  assert.equal(run(s, "PING", "hi"), "$2\r\nhi\r\n");
});

test("SET/GET reply encoding, command names are case-insensitive", () => {
  const s = new Store();
  assert.equal(run(s, "set", "foo", "bar"), "+OK\r\n");
  assert.equal(run(s, "GET", "foo"), "$3\r\nbar\r\n");
  assert.equal(run(s, "GET", "missing"), "$-1\r\n");
});

test("integer replies for DEL / EXISTS / EXPIRE / TTL", () => {
  const s = new Store();
  run(s, "SET", "a", "1");
  assert.equal(run(s, "EXISTS", "a"), ":1\r\n");
  assert.equal(run(s, "TTL", "a"), ":-1\r\n");
  assert.equal(run(s, "EXPIRE", "a", "60"), ":1\r\n");
  assert.equal(run(s, "TTL", "a"), ":60\r\n");
  assert.equal(run(s, "DEL", "a", "zzz"), ":1\r\n");
  assert.equal(run(s, "TTL", "a"), ":-2\r\n");
});

test("SET key value EX seconds", () => {
  const s = new Store();
  assert.equal(run(s, "SET", "a", "1", "EX", "30"), "+OK\r\n");
  assert.equal(run(s, "TTL", "a"), ":30\r\n");
});

test("error replies", () => {
  const s = new Store();
  assert.match(run(s, "GET"), /^-ERR wrong number of arguments for 'get'/);
  assert.match(run(s, "SET", "a"), /^-ERR wrong number of arguments/);
  assert.match(run(s, "SET", "a", "1", "PX", "5"), /^-ERR syntax error/);
  assert.match(run(s, "SET", "a", "1", "EX", "abc"), /^-ERR invalid expire time/);
  assert.match(run(s, "EXPIRE", "a", "abc"), /^-ERR value is not an integer/);
  assert.match(run(s, "NOPE"), /^-ERR unknown command 'NOPE'/);
});

test("bulk length is in bytes, not characters", () => {
  const s = new Store();
  run(s, "SET", "k", "héllo");
  assert.equal(run(s, "GET", "k"), "$6\r\nhéllo\r\n");
});