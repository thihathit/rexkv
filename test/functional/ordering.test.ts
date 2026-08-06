import { test } from "node:test";
import assert from "node:assert/strict";
import { KvStore, tempDbPath } from "./native.ts";

test("async writes on one table apply in call order", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  const puts: Promise<void>[] = [];
  for (let i = 0; i < 50; i++) {
    puts.push(t.put(Buffer.from("key"), Buffer.from(`v${i}`)));
  }
  await Promise.all(puts);
  assert.equal(t.get(Buffer.from("key"))?.toString(), "v49");
  await kv.close();
});

test("awaiting a write means it is applied", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  const p1 = t.put(Buffer.from("k"), Buffer.from("v1"));
  const p2 = t.put(Buffer.from("k"), Buffer.from("v2"));
  await p2;
  assert.equal(t.get(Buffer.from("k"))?.toString(), "v2");
  await p1;
  await kv.close();
});

test("read-your-own-writes: await before reading", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  await t.put(Buffer.from("k"), Buffer.from("v"));
  assert.equal(t.get(Buffer.from("k"))?.toString(), "v");
  await kv.close();
});
