import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "bun";

const here = path.dirname(fileURLToPath(import.meta.url));
const native = path.join(here, "native", "rexkv.node");

if (!existsSync(native)) {
  console.error("missing native/rexkv.node — run `bun run copy-native`");
  process.exit(1);
}

const result = await build({
  entrypoints: ["./index.ts"],
  compile: { outfile: "bun-sfe-build_and_run" },
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

console.log("built bun-sfe-build_and_run (.node bundled into VFS)");
