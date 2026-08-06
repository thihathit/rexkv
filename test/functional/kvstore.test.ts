import { test } from "node:test";
import assert from "node:assert/strict";
import { KvStore, tempDbPath } from "./native.ts";

test("get on missing key returns null", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  assert.equal(t.get(Buffer.from("nope")), null);
  await kv.close();
});

test("put/get round-trip", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  await t.put(Buffer.from("a"), Buffer.from("1"));
  assert.equal(t.get(Buffer.from("a"))?.toString(), "1");
  await kv.close();
});

test("put overwrites", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  await t.put(Buffer.from("k"), Buffer.from("v1"));
  await t.put(Buffer.from("k"), Buffer.from("v2"));
  assert.equal(t.get(Buffer.from("k"))?.toString(), "v2");
  await kv.close();
});

test("delete reports existence and removes", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  assert.equal(await t.delete(Buffer.from("x")), false);
  await t.put(Buffer.from("x"), Buffer.from("1"));
  assert.equal(await t.delete(Buffer.from("x")), true);
  assert.equal(t.get(Buffer.from("x")), null);
  assert.equal(await t.remove(Buffer.from("x")), false);
  await kv.close();
});

test("putBatch inserts many in one transaction", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  await t.putBatch([
    { key: Buffer.from("a"), value: Buffer.from("1") },
    { key: Buffer.from("b"), value: Buffer.from("2") },
  ]);
  assert.equal(t.get(Buffer.from("a"))?.toString(), "1");
  assert.equal(t.get(Buffer.from("b"))?.toString(), "2");
  await kv.close();
});

test("getBatch returns values in request order, null for missing", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  await t.putBatch([
    { key: Buffer.from("a"), value: Buffer.from("1") },
    { key: Buffer.from("b"), value: Buffer.from("2") },
  ]);
  const out = await t.getBatch([Buffer.from("b"), Buffer.from("z"), Buffer.from("a")]);
  assert.deepEqual(
    out.map((v) => v?.toString() ?? null),
    ["2", null, "1"],
  );
  await kv.close();
});

test("tables are lazy: reads on a never-written table are null", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("fresh");
  assert.equal(t.get(Buffer.from("k")), null);
  assert.deepEqual(
    (await t.getBatch([Buffer.from("k")])).map((v) => v ?? null),
    [null],
  );
  await kv.close();
});
