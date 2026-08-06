import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { getKvStore } from "red-kv";
import type { RedKvConstructor } from "red-kv";

const require = createRequire(import.meta.url);
const rustDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../rust");

if (!readdirSync(rustDir).some((f) => f.endsWith(".node"))) {
  const r = spawnSync("bun", ["run", "build"], { cwd: rustDir, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const artifact = readdirSync(rustDir).find((f) => f.endsWith(".node"))!;

/** The `KvStore` constructor, loaded from the freshly built native addon. */
export const KvStore: RedKvConstructor = getKvStore(require(path.join(rustDir, artifact)));

/** A fresh temp database path; the temp dir is removed after the test. */
export function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "red-kv-test-"));
  const dbPath = path.join(dir, "db.redb");
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dbPath;
}
