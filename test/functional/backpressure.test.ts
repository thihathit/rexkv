import { test } from "node:test";
import assert from "node:assert/strict";
import { KvStore, tempDbPath } from "./native.ts";
import type { KvStoreOptions } from "red-kv";

test("full write queue rejects with queue-is-full instead of growing", async () => {
  const kv = new KvStore(tempDbPath(), { maxQueue: 1 } satisfies KvStoreOptions);
  const t = kv.openTable("kv");
  const results = await Promise.allSettled(
    Array.from({ length: 64 }, (_, i) => t.put(Buffer.from(`k${i}`), Buffer.from(`v${i}`))),
  );
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.ok(rejected.length > 0, "expected at least one queue-full rejection");
  for (const r of rejected) {
    assert.match(String(r.reason), /queue is full/);
  }
  await kv.close();
});
