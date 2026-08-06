import { test } from "node:test";
import assert from "node:assert/strict";
import { deserializeJSON, JsonTable, serializeJSON } from "red-kv";
import { KvStore, tempDbPath } from "./native.ts";

test("JsonTable round-trips non-JSON types", async () => {
  const kv = new KvStore(tempDbPath());
  const json = new JsonTable<string, { role: string; at: Date }>(kv.openTable("json"));
  const date = new Date("2026-01-02T03:04:05.000Z");
  await json.put("alice", { role: "admin", at: date });
  const out = json.get("alice");
  assert.ok(out);
  assert.equal(out.role, "admin");
  assert.ok(out.at instanceof Date);
  assert.equal(out.at.toISOString(), date.toISOString());
  await kv.close();
});

test("JsonTable getOr returns fallback for missing keys", async () => {
  const kv = new KvStore(tempDbPath());
  const json = new JsonTable<string, number>(kv.openTable("json"));
  assert.equal(json.getOr("missing", 42), 42);
  await json.put("n", 7);
  assert.equal(json.getOr("n", 42), 7);
  await kv.close();
});

test("JsonTable getBatch returns values in order, null for missing", async () => {
  const kv = new KvStore(tempDbPath());
  const json = new JsonTable<string, unknown>(kv.openTable("json"));
  await json.putBatch([
    { key: "a", value: 1 },
    { key: "b", value: [true, false] },
  ]);
  const out = await json.getBatch(["b", "z", "a"]);
  assert.deepEqual(out, [[true, false], null, 1]);
  await kv.close();
});

test("serializeJSON/deserializeJSON round-trip exotic types via __$p", async () => {
  const kv = new KvStore(tempDbPath());
  const t = kv.openTable("kv");
  const date = new Date("2026-01-02T03:04:05.000Z");
  const payload = { date, buf: Buffer.from([1, 2]), m: new Map([["k", "v"]]), big: 123n };
  const bytes = serializeJSON(payload);
  assert.ok(bytes.toString().includes('"__$p"'));
  await t.put(Buffer.from("x"), bytes);

  const out = deserializeJSON<{
    date: Date;
    buf: Buffer;
    m: Map<string, string>;
    big: bigint;
  }>(t.get(Buffer.from("x"))!);
  assert.ok(out.date instanceof Date);
  assert.equal(out.date.toISOString(), date.toISOString());
  assert.ok(Buffer.isBuffer(out.buf));
  assert.ok(out.m instanceof Map && out.m.get("k") === "v");
  assert.equal(out.big, 123n);
  await kv.close();
});
