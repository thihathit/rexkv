import { getKvStore } from "red-kv";

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
