import { createRequire } from "node:module";
import { getKvStore } from "red-kv";
import nativePath from "./red-kv.node" with { type: "file" };

// Build with `bun run build` (build.ts embeds the artifact rust/ built) then run `./bun-sfe`.
// Running `bun index.ts` directly fails: bun rejects `type: "file"` imports of
// .node files outside a bundler — that's the SFE scenario, not the plain consumer one.
const KvStore = getKvStore(createRequire(import.meta.url)(nativePath));
const kv = new KvStore("/tmp/bun-sfe-test.redb");

kv.put(Buffer.from("hello"), Buffer.from("world"));
console.log("get:", kv.get(Buffer.from("hello"))?.toString());

kv.putBatch([
  { key: Buffer.from("a"), value: Buffer.from("1") },
  { key: Buffer.from("b"), value: Buffer.from("2") },
]);
console.log("batch a:", kv.get(Buffer.from("a"))?.toString());
console.log("delete b:", kv.delete(Buffer.from("b")));
console.log("b after delete:", kv.get(Buffer.from("b")));
console.log("BUN SFE TEST OK");
