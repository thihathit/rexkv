import type { KvStore } from "./types.d.ts";

export type { KvEntry, KvStore } from "./types.d.ts";

/** Type of the `KvStore` constructor exported by the `.node` binding. */
export type RedKvConstructor = typeof KvStore;

/**
 * Unwrap the `KvStore` constructor from a loaded red-kv `.node` module.
 *
 * The `.node` file is loaded by the consuming project, in whatever way
 * fits their setup — `createRequire`, Bun's native `import`, a bundler
 * plugin, etc. Pass the loaded module here to get the constructor back:
 *
 * ```ts
 * import { createRequire } from "node:module";
 * const mod = createRequire(import.meta.url)("./red-kv.linux-x64-gnu.node");
 * const KvStore = getKvStore(mod);
 * ```
 */
export function getKvStore(module: unknown): RedKvConstructor {
  const native = module as { KvStore?: RedKvConstructor };

  if (!native.KvStore) {
    throw new Error("red-kv: loaded module did not export a KvStore binding");
  }

  return native.KvStore;
}
