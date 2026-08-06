import { deserializeJSON, getKvStore, JsonTable, serializeJSON } from "red-kv";

const KvStore = getKvStore(require("./native/red-kv.node"));
const kv = new KvStore("/tmp/bun-sfe-build_and_run.redb");

const store = kv.openTable("kv");
await store.put(Buffer.from("hello"), Buffer.from("world"));
console.log("get:", store.get(Buffer.from("hello"))?.toString());

await store.putBatch([
  { key: Buffer.from("a"), value: Buffer.from("1") },
  { key: Buffer.from("b"), value: Buffer.from("2") },
]);
console.log("batch a:", store.get(Buffer.from("a"))?.toString());
console.log("delete b:", await store.delete(Buffer.from("b")));
console.log("b after delete:", store.get(Buffer.from("b")));

const users = kv.openTable("users");
await users.put(Buffer.from("alice"), Buffer.from("admin"));
console.log("users.get(alice):", users.get(Buffer.from("alice"))?.toString());
console.log("remove alice:", await users.remove(Buffer.from("alice")));
console.log("alice after remove:", users.get(Buffer.from("alice")));
console.log("kv table untouched:", store.get(Buffer.from("hello"))?.toString());

const json = new JsonTable(kv.openTable("json"));
await json.put("alice", { role: "admin" });
console.log("json.get(alice):", JSON.stringify(json.get("alice")));
await json.put(Buffer.from("count"), 5);
console.log("json.get(count):", json.get("count"));
console.log("json.getOr(missing):", JSON.stringify(json.getOr("missing", null)));
await json.putBatch([
  { key: "x", value: { n: 1 } },
  { key: "y", value: [1, 2, 3] },
]);
console.log("json.get(x):", JSON.stringify(json.get("x")));
console.log("json.delete(alice):", await json.delete("alice"));
console.log("alice after json delete:", json.get("alice"));

const typed = new JsonTable<string, { role: string }>(kv.openTable("json"));
await typed.put("bob", { role: "user" });
const bob: { role: string } | null = typed.get("bob");
console.log("typed.get(bob):", JSON.stringify(bob));
console.log("typed.getOr(missing):", JSON.stringify(typed.getOr("nope", { role: "anon" })));

const events = new JsonTable<string, { at: Date }>(kv.openTable("json"));
const eventDate = new Date("2026-01-02T03:04:05.000Z");
await events.put("event", { at: eventDate });
const event = events.get("event");
console.log("date instanceof Date:", event?.at instanceof Date);
console.log("date iso:", event?.at.toISOString());

const rawKey = Buffer.from("standalone");
const standalone = kv.openTable("kv");
await standalone.put(rawKey, serializeJSON({ at: eventDate, n: 1 }));
const decoded = deserializeJSON<{ at: Date; n: number }>(standalone.get(rawKey)!);
console.log("standalone date instanceof Date:", decoded.at instanceof Date);
console.log("standalone n:", decoded.n);

const fresh = kv.openTable("never-written");
console.log("get on never-written table:", fresh.get(Buffer.from("k")));
console.log(
  "getBatch on never-written table:",
  (await fresh.getBatch([Buffer.from("k")])).map((v) => v ?? null),
);
console.log(
  "serializeJSON embeds metadata:",
  serializeJSON({ at: eventDate }).toString().includes('"__$p"'),
);
console.log(
  "serializeJSON plain skips metadata:",
  !serializeJSON({ a: 1 }).toString().includes('"__$p"'),
);

const exotic = serializeJSON({
  date: eventDate,
  buf: Buffer.from([1, 2, 3]),
  u8: new Uint8Array([4, 5]),
  m: new Map([["k", "v"]]),
  s: new Set(["a", "b"]),
  re: /ab+c/gi,
  big: 12345678901234567890n,
  nan: NaN,
  inf: Infinity,
});
const ex = deserializeJSON<{
  date: Date;
  buf: Buffer;
  u8: Uint8Array;
  m: Map<string, string>;
  s: Set<string>;
  re: RegExp;
  big: bigint;
  nan: number;
  inf: number;
}>(exotic);
console.log(
  "exotic roundtrip:",
  ex.date instanceof Date,
  Buffer.isBuffer(ex.buf),
  ex.u8 instanceof Uint8Array && !Buffer.isBuffer(ex.u8),
  ex.m instanceof Map && ex.m.get("k") === "v",
  ex.s instanceof Set && ex.s.has("a"),
  ex.re instanceof RegExp && ex.re.flags === "gi",
  ex.big === 12345678901234567890n,
  Number.isNaN(ex.nan),
  ex.inf === Infinity,
);

const nested = serializeJSON({
  root: {
    inner: { at: eventDate },
    deep: [{ m: new Map([["k", 1]]) }],
  },
});
const nestedOut = deserializeJSON<{
  root: { inner: { at: Date }; deep: { m: Map<string, number> }[] };
}>(nested);
console.log(
  "nested per-level roundtrip:",
  nestedOut.root.inner.at instanceof Date,
  nestedOut.root.deep[0].m instanceof Map && nestedOut.root.deep[0].m.get("k") === 1,
);
console.log("nested uses per-level __$p:", nested.toString().includes('"__$p"'));

let collisionThrew = false;
try {
  serializeJSON({ a: 1, __$p: {} });
} catch {
  collisionThrew = true;
}
console.log("__$p collision throws:", collisionThrew);

console.log(
  "getBatch:",
  (await store.getBatch([Buffer.from("a"), Buffer.from("missing")])).map(
    (v) => v?.toString() ?? null,
  ),
);
console.log(
  "json.getBatch:",
  JSON.stringify(await json.getBatch(["x", "missing"]), (_, v) => (v === undefined ? null : v)),
);

await kv.close();
let closedThrows = false;
try {
  store.get(Buffer.from("hello"));
} catch {
  closedThrows = true;
}
console.log("get after close throws:", closedThrows);

let openClosedThrows = false;
try {
  kv.openTable("late");
} catch {
  openClosedThrows = true;
}
console.log("openTable after close throws:", openClosedThrows);

let tableClosedThrows = false;
try {
  users.get(Buffer.from("alice"));
} catch {
  tableClosedThrows = true;
}
console.log("table get after close throws:", tableClosedThrows);

let writeAfterCloseThrew = false;
try {
  await store.put(Buffer.from("late"), Buffer.from("write"));
} catch {
  writeAfterCloseThrew = true;
}
console.log("write after close rejects:", writeAfterCloseThrew);

console.log("BUN SFE BUILD-AND-RUN OK");
