import { test } from "node:test";
import assert from "node:assert/strict";
import type { KvCompression } from "rexkv";
import { KvStore, tempDbPath } from "./native.ts";

const lz4 = "lz4" as KvCompression;

test("lz4: put/get round-trips a compressible value", async () => {
  const kv = new KvStore(tempDbPath(), { compression: lz4 });
  const t = kv.openTable("kv");
  const value = Buffer.from(JSON.stringify({ body: "x".repeat(4096) }));
  await t.put(Buffer.from("a"), value);
  assert.deepEqual(t.get(Buffer.from("a")), value);
  await kv.close();
});

test("lz4: small and incompressible values still round-trip", async () => {
  const kv = new KvStore(tempDbPath(), { compression: lz4 });
  const t = kv.openTable("kv");
  await t.put(Buffer.from("small"), Buffer.from("hi"));
  const binary = Buffer.from(Array.from({ length: 1024 }, () => Math.floor(Math.random() * 256)));
  await t.put(Buffer.from("binary"), binary);
  assert.equal(t.get(Buffer.from("small"))?.toString(), "hi");
  assert.deepEqual(t.get(Buffer.from("binary")), binary);
  await kv.close();
});

test("lz4: putBatch + getBatch round-trip", async () => {
  const kv = new KvStore(tempDbPath(), { compression: lz4 });
  const t = kv.openTable("kv");
  const values = Array.from({ length: 50 }, (_, i) =>
    Buffer.from(JSON.stringify({ i, body: "y".repeat(2048) })),
  );
  await t.putBatch(values.map((v, i) => ({ key: Buffer.from(String(i)), value: v })));
  const out = await t.getBatch(values.map((_, i) => Buffer.from(String(i))));
  assert.deepEqual(out, values);
  await kv.close();
});

test("lz4: data survives reopening with the same mode", async () => {
  const path = tempDbPath();
  const expected = JSON.stringify({ body: "z".repeat(4096) });
  {
    const kv = new KvStore(path, { compression: lz4 });
    const t = kv.openTable("kv");
    await t.put(Buffer.from("a"), Buffer.from(expected));
    await kv.close();
  }
  {
    const kv = new KvStore(path, { compression: lz4 });
    const t = kv.openTable("kv");
    assert.equal(t.get(Buffer.from("a"))?.toString(), expected);
    await kv.close();
  }
});
