import { test } from "node:test";
import assert from "node:assert/strict";
import type { KvCompression, KvDurability } from "rexkv";
import { KvStore, tempDbPath } from "./native.ts";

const lz4 = "lz4" as KvCompression;
const none = "none" as KvCompression;
const eventual = "eventual" as KvDurability;

test("status reports config, open state, and an empty queue", async () => {
  const kv = new KvStore(tempDbPath(), {
    maxQueue: 8,
    durability: eventual,
    putCompression: none,
  });
  const t = kv.openTable("kv");
  await t.put(Buffer.from("k"), Buffer.from("v"));

  const s = kv.status();
  assert.equal(s.open, true);
  assert.equal(s.maxQueue, 8);
  assert.equal(s.durability, eventual);
  assert.equal(s.putCompression, none);
  assert.equal(s.pending, 0);
  assert.equal(s.rejected, 0);
  assert.ok(s.fileSizeBytes !== undefined && s.fileSizeBytes > 0);

  await kv.close();
  assert.equal(kv.status().open, false);
});

test("status reflects default options", async () => {
  const kv = new KvStore(tempDbPath());
  const s = kv.status();
  assert.equal(s.maxQueue, 1024);
  assert.equal(s.durability, "immediate");
  assert.equal(s.putCompression, lz4);
  await kv.close();
});

test("status counts queue-full rejections", async () => {
  const kv = new KvStore(tempDbPath(), { maxQueue: 1 });
  const t = kv.openTable("kv");
  const results = await Promise.allSettled(
    Array.from({ length: 64 }, (_, i) => t.put(Buffer.from(`k${i}`), Buffer.from(`v${i}`))),
  );
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  assert.ok(rejected.length > 0, "expected at least one queue-full rejection");
  const s = kv.status();
  assert.equal(s.rejected, rejected.length);
  assert.equal(s.pending, 0);
  await kv.close();
});
