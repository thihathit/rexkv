import { deserializeJSON, getKvStore, JsonTable, serializeJSON } from "red-kv";

const KvStore = getKvStore(require("./native/red-kv.node"));
const kv = new KvStore("/tmp/bun-sfe-build_and_run.redb");

const store = kv.openTable("kv");
store.put(Buffer.from("hello"), Buffer.from("world"));
console.log("get:", store.get(Buffer.from("hello"))?.toString());

store.putBatch([
  { key: Buffer.from("a"), value: Buffer.from("1") },
  { key: Buffer.from("b"), value: Buffer.from("2") },
]);
console.log("batch a:", store.get(Buffer.from("a"))?.toString());
console.log("delete b:", store.delete(Buffer.from("b")));
console.log("b after delete:", store.get(Buffer.from("b")));

const users = kv.openTable("users");
users.put(Buffer.from("alice"), Buffer.from("admin"));
console.log("users.get(alice):", users.get(Buffer.from("alice"))?.toString());
console.log("remove alice:", users.remove(Buffer.from("alice")));
console.log("alice after remove:", users.get(Buffer.from("alice")));
console.log("kv table untouched:", store.get(Buffer.from("hello"))?.toString());

const json = new JsonTable(kv.openTable("json"));
json.put("alice", { role: "admin" });
console.log("json.get(alice):", JSON.stringify(json.get("alice")));
json.put(Buffer.from("count"), 5);
console.log("json.get(count):", json.get("count"));
console.log("json.getOr(missing):", JSON.stringify(json.getOr("missing", null)));
json.putBatch([
  { key: "x", value: { n: 1 } },
  { key: "y", value: [1, 2, 3] },
]);
console.log("json.get(x):", JSON.stringify(json.get("x")));
console.log("json.delete(alice):", json.delete("alice"));
console.log("alice after json delete:", json.get("alice"));

const typed = new JsonTable<string, { role: string }>(kv.openTable("json"));
typed.put("bob", { role: "user" });
const bob: { role: string } | null = typed.get("bob");
console.log("typed.get(bob):", JSON.stringify(bob));
console.log("typed.getOr(missing):", JSON.stringify(typed.getOr("nope", { role: "anon" })));

const events = new JsonTable<string, { at: Date }>(kv.openTable("json"));
const eventDate = new Date("2026-01-02T03:04:05.000Z");
events.put("event", { at: eventDate });
const event = events.get("event");
console.log("date instanceof Date:", event?.at instanceof Date);
console.log("date iso:", event?.at.toISOString());

const rawKey = Buffer.from("standalone");
kv.openTable("kv").put(rawKey, serializeJSON({ at: eventDate, n: 1 }));
const decoded = deserializeJSON<{ at: Date; n: number }>(
  kv.openTable("kv").get(rawKey)!,
);
console.log("standalone date instanceof Date:", decoded.at instanceof Date);
console.log("standalone n:", decoded.n);
console.log(
  "serializeJSON embeds metadata:",
  serializeJSON({ at: eventDate }).toString().includes('"_$properties"'),
);
console.log(
  "serializeJSON plain skips metadata:",
  !serializeJSON({ a: 1 }).toString().includes('"_$properties"'),
);

kv.close();
let closedThrows = false;
try {
  store.get(Buffer.from("hello"));
} catch {
  closedThrows = true;
}
console.log("get after close throws:", closedThrows);

let tableClosedThrows = false;
try {
  users.get(Buffer.from("alice"));
} catch {
  tableClosedThrows = true;
}
console.log("table get after close throws:", tableClosedThrows);

console.log("BUN SFE BUILD-AND-RUN OK");
