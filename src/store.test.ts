import { Store } from "./store";
import { test } from "vitest";
import assert from "node:assert/strict";

// Fake clock: tests fast-forward time instead of sleeping.
function make() {
  let t = 1_000_000;
  const store = new Store(() => t);
  return { store, advance: (ms: number) => (t += ms) };
}

test("SET / GET round trip, missing key is null", () => {
  const { store } = make();
  assert.equal(store.get("nope"), null);
  store.set("a", "1");
  assert.equal(store.get("a"), "1");
  store.set("a", "2");
  assert.equal(store.get("a"), "2");
});

test("lazy expiry: GET returns null after TTL, key is removed", () => {
  const { store, advance } = make();
  store.set("k", "v");
  store.expire("k", 1);
  assert.equal(store.get("k"), "v");
  advance(1001);
  assert.equal(store.get("k"), null);
  assert.equal(store.size, 0);
});

test("active expiry: sweep removes keys that are never read", () => {
  const { store, advance } = make();
  for (let i = 0; i < 100; i++) {
    store.set(`k${i}`, "v");
    store.expire(`k${i}`, 1);
  }
  assert.equal(store.size, 100);
  advance(1001);
  store.sweep();
  assert.equal(store.size, 0); // reclaimed without any GET
});

test("sweep leaves unexpired keys alone", () => {
  const { store, advance } = make();
  store.set("short", "v");
  store.expire("short", 1);
  store.set("long", "v");
  store.expire("long", 100);
  store.set("forever", "v");
  advance(1001);
  store.sweep();
  assert.equal(store.get("short"), null);
  assert.equal(store.get("long"), "v");
  assert.equal(store.get("forever"), "v");
});

test("sweep rotates, so it eventually reaches keys beyond the first sample", () => {
  const { store, advance } = make();
  // 40 long-lived TTL keys inserted first would hog a naive "first 20" sample
  for (let i = 0; i < 40; i++) {
    store.set(`long${i}`, "v");
    store.expire(`long${i}`, 1000);
  }
  store.set("victim", "v");
  store.expire("victim", 1);
  advance(1001);
  store.sweep(); // round 1 samples 20 long keys, rotates them
  store.sweep(); // later sweeps reach the rest of the set
  store.sweep();
  assert.equal(store.size, 40);
});

test("TTL: -2 missing, -1 no expiry, N otherwise", () => {
  const { store, advance } = make();
  assert.equal(store.ttl("nope"), -2);
  store.set("a", "1");
  assert.equal(store.ttl("a"), -1);
  store.expire("a", 60);
  assert.equal(store.ttl("a"), 60);
  advance(10_000);
  assert.equal(store.ttl("a"), 50);
});

test("SET clears an existing TTL", () => {
  const { store } = make();
  store.set("a", "1");
  store.expire("a", 60);
  store.set("a", "2");
  assert.equal(store.ttl("a"), -1);
});

test("EXPIRE on missing key returns 0; on existing returns 1", () => {
  const { store } = make();
  assert.equal(store.expire("nope", 10), 0);
  store.set("a", "1");
  assert.equal(store.expire("a", 10), 1);
});

test("EXPIRE with non-positive seconds deletes the key", () => {
  const { store } = make();
  store.set("a", "1");
  assert.equal(store.expire("a", 0), 1);
  assert.equal(store.get("a"), null);
});

test("DEL / EXISTS count only live keys", () => {
  const { store, advance } = make();
  store.set("a", "1");
  store.set("b", "2");
  store.expire("b", 1);
  advance(1001);
  assert.equal(store.exists(["a", "b", "c"]), 1);
  assert.equal(store.del(["a", "b", "c"]), 1);
  assert.equal(store.size, 0);
});

test("EXISTS counts duplicates like Redis", () => {
  const { store } = make();
  store.set("a", "1");
  assert.equal(store.exists(["a", "a"]), 2);
});