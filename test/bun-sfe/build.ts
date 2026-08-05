import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "bun";

const here = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(here, "../../rust");

if (!readdirSync(rustDir).some((f) => f.endsWith(".node"))) {
  const r = spawnSync("bun", ["run", "build"], { cwd: rustDir, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const result = await build({
  entrypoints: ["./index.ts"],
  compile: { outfile: "bun-sfe" },
  plugins: [
    {
      name: "red-kv-native",
      setup(build) {
        build.onResolve({ filter: /\.node$/ }, () => {
          const native = readdirSync(rustDir).find((f) => f.endsWith(".node"))!;
          return { path: path.join(rustDir, native), namespace: "redkv" };
        });
        build.onLoad({ filter: /.*/, namespace: "redkv" }, async (args) => ({
          loader: "file",
          contents: new Uint8Array(await Bun.file(args.path).arrayBuffer()),
        }));
      },
    },
  ],
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

console.log("built bun-sfe");
