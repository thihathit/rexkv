import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getKvStore } from "rexkv";
import type { RexkvConstructor } from "rexkv";

const require = createRequire(import.meta.url);
const rustDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../rust");

if (!readdirSync(rustDir).some((f) => f.endsWith(".node"))) {
  const r = spawnSync("bun", ["run", "build"], { cwd: rustDir, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const artifact = readdirSync(rustDir).find((f) => f.endsWith(".node"))!;

/** The `KvStore` constructor, loaded from the freshly built native addon. */
export const KvStore: RexkvConstructor = getKvStore(require(path.join(rustDir, artifact)));

const cleanups: string[] = [];
process.on("exit", () => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp database path; the temp dir is removed when the process exits. */
export function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rexkv-bench-"));
  cleanups.push(dir);
  return path.join(dir, "db.redb");
}
