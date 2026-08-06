import { test } from "node:test";
import assert from "node:assert/strict";
import { KvStore, tempDbPath } from "./native.ts";

test("two stores are independent", async () => {
  const kvA = new KvStore(tempDbPath());
  const kvB = new KvStore(tempDbPath());
  await kvA.openTable("kv").put(Buffer.from("k"), Buffer.from("A"));
  await kvB.openTable("kv").put(Buffer.from("k"), Buffer.from("B"));
  assert.equal(kvA.openTable("kv").get(Buffer.from("k"))?.toString(), "A");
  assert.equal(kvB.openTable("kv").get(Buffer.from("k"))?.toString(), "B");

  await kvA.close();
  assert.equal(kvB.openTable("kv").get(Buffer.from("k"))?.toString(), "B");
  await kvB.close();
});

test("reopening a path sees persisted data", async () => {
  const path = tempDbPath();
  const kv = new KvStore(path);
  await kv.openTable("kv").put(Buffer.from("k"), Buffer.from("v"));
  await kv.close();

  const kv2 = new KvStore(path);
  assert.equal(kv2.openTable("kv").get(Buffer.from("k"))?.toString(), "v");
  await kv2.close();
});
