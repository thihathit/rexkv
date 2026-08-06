import { test } from "node:test";
import assert from "node:assert/strict";
import { KvStore, tempDbPath } from "./native.ts";

test("close drains queued writes before resolving", async () => {
  const path = tempDbPath();
  const kv = new KvStore(path);
  const t = kv.openTable("kv");
  for (let i = 0; i < 50; i++) {
    void t.put(Buffer.from(`k${i}`), Buffer.from(`v${i}`));
  }
  await kv.close();

  const kv2 = new KvStore(path);
  assert.equal(kv2.openTable("kv").get(Buffer.from("k49"))?.toString(), "v49");
  await kv2.close();
});

test("ops on a closed store throw database is closed", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  await t.put(Buffer.from("k"), Buffer.from("v"));
  await kv.close();

  assert.throws(() => t.get(Buffer.from("k")), /database is closed/);
  assert.throws(() => kv.openTable("late"), /database is closed/);
  await assert.rejects(t.put(Buffer.from("k2"), Buffer.from("v2")), /database is closed/);
  await assert.rejects(kv.close(), /database is closed/);
});

test("writes issued after close() are not terminated silently", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  const closePromise = kv.close();
  const late = t.put(Buffer.from("k"), Buffer.from("v"));
  await assert.rejects(late, /database is closed/);
  await closePromise;
});
