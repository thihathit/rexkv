import { test } from "node:test";
import assert from "node:assert/strict";
import { KvStore, tempDbPath } from "./native.ts";
import type { KvDurability, KvStoreOptions } from "rexkv";

for (const durability of ["immediate", "eventual", "none"] as KvDurability[]) {
  test(`durability "${durability}": write commits and reads back`, async () => {
    const kv = new KvStore(tempDbPath(), { durability } satisfies KvStoreOptions);
    const t = kv.openTable("kv");
    await t.put(Buffer.from("k"), Buffer.from("v"));
    assert.equal(t.get(Buffer.from("k"))?.toString(), "v");
    await kv.close();
  });
}

test("maxQueue option is accepted and ops still work", async () => {
  const kv = new KvStore(tempDbPath(), { maxQueue: 1 } satisfies KvStoreOptions);
  const t = kv.openTable("kv");
  await t.put(Buffer.from("k"), Buffer.from("v"));
  assert.equal(t.get(Buffer.from("k"))?.toString(), "v");
  await kv.close();
});

test("default (immediate) writes persist across reopen", async () => {
  const path = tempDbPath();
  const kv = new KvStore(path);
  await kv.openTable("kv").put(Buffer.from("k"), Buffer.from("v"));
  await kv.close();

  const kv2 = new KvStore(path);
  assert.equal(kv2.openTable("kv").get(Buffer.from("k"))?.toString(), "v");
  await kv2.close();
});
