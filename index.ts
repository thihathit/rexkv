import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import type {
  KvEntry,
  RedKvConstructor,
  RedKvInstance,
  RedKvPlatformKey,
} from "./types";

export type { KvEntry, RedKvConstructor, RedKvInstance, RedKvPlatformKey };

const PLATFORM_FILENAMES: Record<RedKvPlatformKey, string> = {
  "darwin-arm64": "red-kv.darwin-arm64.node",
  "darwin-x64": "red-kv.darwin-x64.node",
  "linux-arm64": "red-kv.linux-arm64-gnu.node",
  "linux-x64": "red-kv.linux-x64-gnu.node",
  "win32-x64": "red-kv.win32-x64-msvc.node",
};

/**
 * Load the red-kv native binding from a real filesystem path.
 *
 * Use this when you already have a concrete path to the platform-specific
 * .node file — e.g. a file you shipped next to your compiled executable,
 * or one you've already extracted from a bundler's virtual filesystem via
 * `loadRedKvFromEmbedded` below.
 */
export function loadRedKv(nodeFilePath: string): RedKvConstructor {
  const req = typeof require === "function" ? require : createRequire(import.meta.url);
  const native = req(nodeFilePath) as { KvStore?: RedKvConstructor };

  if (!native?.KvStore) {
    throw new Error(`red-kv: "${nodeFilePath}" did not export a KvStore binding`);
  }

  return native.KvStore;
}

/**
 * For Bun `--compile` / Deno `compile` assets embedded via
 * `with { type: "file" }`: the native dynamic loader (dlopen) cannot read a
 * file straight out of a bundler's virtual filesystem, so this writes the
 * embedded asset out to a real temp file first, then loads it from there.
 *
 * The static import itself must live in *your* entrypoint, not here —
 * bundlers resolve `with { type: "file" }` imports at compile time, so the
 * literal import path has to be visible to the bundler statically:
 *
 *   import embedded from "./native/red-kv.linux-x64-gnu.node" with { type: "file" };
 *   const KvStore = loadRedKvFromEmbedded(embedded);
 */
export function loadRedKvFromEmbedded(embeddedAssetPath: string): RedKvConstructor {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "red-kv-"));
  const extracted = path.join(tmpDir, "red-kv.node");
  fs.writeFileSync(extracted, fs.readFileSync(embeddedAssetPath));
  return loadRedKv(extracted);
}

/**
 * Given a directory containing the prebuilt red-kv.*.node files (e.g. a
 * `native/` folder shipped next to your compiled binary), resolve the
 * correct filename for the *currently running* platform/arch.
 *
 * This is a runtime decision — it's meant for the "ship files alongside
 * the SFE binary" pattern, not for picking which asset to statically
 * embed at build time (see README for why those are different problems).
 */
export function resolveRedKvPath(nativeDir: string): string {
  const key = `${process.platform}-${process.arch}` as RedKvPlatformKey;
  const filename = PLATFORM_FILENAMES[key];

  if (!filename) {
    throw new Error(`red-kv: no prebuilt binding for platform "${key}"`);
  }

  return path.join(nativeDir, filename);
}

/**
 * Convenience: resolve + load in one call, for the "sidecar folder next to
 * the SFE binary" pattern (no VFS embedding involved).
 */
export function loadRedKvFromDir(nativeDir: string): RedKvConstructor {
  return loadRedKv(resolveRedKvPath(nativeDir));
}
