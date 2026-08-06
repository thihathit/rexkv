import { getKvStore } from "red-kv";

const KvStore = getKvStore(require("./native/red-kv.node"));
const kv = new KvStore("/tmp/bun-sfe-build_and_run.redb");

kv.put(Buffer.from("hello"), Buffer.from("world"));
console.log("get:", kv.get(Buffer.from("hello"))?.toString());

kv.putBatch([
  { key: Buffer.from("a"), value: Buffer.from("1") },
  { key: Buffer.from("b"), value: Buffer.from("2") },
]);
console.log("batch a:", kv.get(Buffer.from("a"))?.toString());
console.log("delete b:", kv.delete(Buffer.from("b")));
console.log("b after delete:", kv.get(Buffer.from("b")));
console.log("BUN SFE BUILD-AND-RUN OK");
