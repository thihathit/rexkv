import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(here, "../../rust");

if (!readdirSync(rustDir).some((f) => f.endsWith(".node"))) {
  const r = spawnSync("bun", ["run", "build"], { cwd: rustDir, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const artifact = readdirSync(rustDir).find((f) => f.endsWith(".node"))!;
const out = path.join(here, "native", "rexkv.node");
mkdirSync(path.dirname(out), { recursive: true });
copyFileSync(path.join(rustDir, artifact), out);
console.log(`copied rust/${artifact} -> native/rexkv.node`);
