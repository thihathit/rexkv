import type { KvStore, KvTable } from "./types.d.ts";

export type { KvDurability, KvEntry, KvStore, KvStoreOptions, KvTable } from "./types.d.ts";

/** Key accepted by `JsonTable`; strings are utf8-encoded to bytes. */
export type JsonKey = Buffer | string;

/** Entry accepted by `JsonTable.putBatch`. */
export interface JsonEntry<K extends JsonKey = JsonKey, V = unknown> {
  key: K;
  value: V;
}

/** Type of the `KvStore` constructor exported by the `.node` binding. */
export type RexkvConstructor = typeof KvStore;

/**
 * Unwrap the `KvStore` constructor from a loaded rexkv `.node` module.
 *
 * The `.node` file is loaded by the consuming project, in whatever way
 * fits their setup — `createRequire`, Bun's native `import`, a bundler
 * plugin, etc. Pass the loaded module here to get the constructor back:
 *
 * ```ts
 * import { createRequire } from "node:module";
 * const mod = createRequire(import.meta.url)("./rexkv.linux-x64-gnu.node");
 * const KvStore = getKvStore(mod);
 * ```
 */
export function getKvStore(module: unknown): RexkvConstructor {
  const native = module as { KvStore?: RexkvConstructor };

  if (!native.KvStore) {
    throw new Error("rexkv: loaded module did not export a KvStore binding");
  }

  return native.KvStore;
}

/**
 * JSON-encode a JS value to bytes. Types JSON can't round-trip (`Date`,
 * `Buffer`/`Uint8Array`, `NaN`, `±Infinity`, `Map`, `Set`, `RegExp`,
 * `BigInt`) are restored on decode. Each object level that directly holds
 * such a value carries one `"__$p"` metadata key mapping a short relative
 * path (property name, plus array indices) to a type tag. When the root
 * itself is not a plain object (e.g. an array of `Date`s), the value is
 * wrapped as `{ "__$p": ..., "__$v": ... }`. Values without any of these
 * types get no metadata and no extra work. `undefined` is dropped and `null`
 * stays `null`, per JSON semantics. The `"__$p"` and `"__$v"` keys are
 * reserved — an input that already contains them throws.
 */
export function serializeJSON(value: unknown): Buffer {
  const { replacer, state } = makeDetector();
  const text = JSON.stringify(value, replacer);

  if (!state.found) {
    return Buffer.from(text, "utf8");
  }

  const out = createTransformer().transform(value);
  return Buffer.from(JSON.stringify(out), "utf8");
}

/**
 * Decode bytes produced by `serializeJSON` (or any JSON) back to a JS value.
 * Values listed in `"__$p"` metadata are revived to their original form.
 * Throws a `SyntaxError` if the bytes are not valid JSON.
 */
export function deserializeJSON<T = unknown>(bytes: Buffer): T {
  return reviveTree(JSON.parse(bytes.toString("utf8")) as unknown) as T;
}

const PROPERTY_MARKER = "__$p";
const VALUE_KEY = "__$v";
const TAG_PATH = "";

// A JSON.stringify replacer never sees a `Date`: Date.prototype.toJSON runs
// first, turning it into an ISO string. But `this[key]` is the value BEFORE
// toJSON, so the replacer can still spot non-JSON types. The detector pass
// only records whether any were found (and throws on reserved keys); the
// transformer pass then copies the tree from the original value, attaching
// one short `__$p` metadata key to each level that directly holds such a value.
function makeDetector(): {
  replacer: (this: Record<string, unknown>, key: string, value: unknown) => unknown;
  state: { found: boolean };
} {
  const pathFor = new WeakMap<object, string>();
  const state = { found: false };

  const replacer = function (this: Record<string, unknown>, key: string, value: unknown): unknown {
    // oxlint-disable-next-line no-this-alias -- replacer `this` is the holder object
    const thisObj: unknown = this;
    const parentPath =
      thisObj !== null && typeof thisObj === "object" ? (pathFor.get(thisObj as object) ?? "") : "";
    const path = key === "" ? "" : parentPath === "" ? key : `${parentPath}/${key}`;

    let result = value;
    if (thisObj !== null && typeof thisObj === "object" && hasOwn(thisObj, key)) {
      const original = (thisObj as Record<string, unknown>)[key];
      if (key === PROPERTY_MARKER || key === VALUE_KEY) {
        throw new Error(
          `rexkv serializeJSON: key ${JSON.stringify(key)} is reserved at ${JSON.stringify(path)}`,
        );
      }
      const tag = detectType(original);
      if (tag !== null) {
        state.found = true;
        result = toJSON(original, tag);
      }
    }

    if (result !== null && typeof result === "object") {
      pathFor.set(result as object, path);
    }
    return result;
  };

  return { replacer, state };
}
// Convert a detected special value into the JSON-safe form used on disk. The
// detector replacer runs these conversions so `JSON.stringify` never sees a
// value it can't serialize (e.g. `BigInt`); the transformer then rewrites the
// tree from the original value with the same forms.
function toJSON(value: unknown, tag: string): unknown {
  if (tag === "map") {
    return Array.from(value as Map<unknown, unknown>);
  }
  if (tag === "set") {
    return Array.from(value as Set<unknown>);
  }
  if (tag === "regexp") {
    const re = value as RegExp;
    return [re.source, re.flags];
  }
  if (tag === "bigint") {
    return (value as bigint).toString();
  }
  if (tag === "buffer" || tag === "uint8array") {
    return { data: Array.from(value as Uint8Array) };
  }
  if (tag === "nan" || tag === "infinity" || tag === "-infinity") {
    return null;
  }
  return value;
}

// Walk the original value tree and copy-transform it into a JSON-safe form.
// Each level (plain object or array) that directly holds a special value gets
// one `__$p` key mapping a short relative path (bare property name, plus array
// indices) to its type tag. Levels with no special children are returned
// unchanged — for a plain object that means the original is reused when none
// of its children are tagged.
function createTransformer(): {
  transform: (value: unknown) => unknown;
} {
  const transform = (value: unknown): unknown => {
    const cache = new WeakMap<object, unknown>();

    // Transform an array, tagging `path` (itself or its nested special
    // children) on the wrapper. Used for plain arrays and for Map/Set,
    // whose entries must be walked so nested specials are tagged too.
    const arrayTransform = (
      arr: unknown[],
      path: string | null,
      cache: WeakMap<object, unknown>,
    ): { out: unknown; tags: Record<string, string> } => {
      const out: unknown[] = [];
      const tags: Record<string, string> = {};
      cache.set(arr, out);
      for (let i = 0; i < arr.length; i++) {
        const { out: child, tags: childTags } = recurse(arr[i], detectType(arr[i]));
        out[i] = child;
        if (hasOwn(childTags, TAG_PATH)) {
          tags[String(i)] = childTags[TAG_PATH];
        } else {
          for (const childPath of Object.keys(childTags)) {
            tags[`${i}/${childPath}`] = childTags[childPath];
          }
        }
      }
      if (path !== null) {
        tags[TAG_PATH] = path;
      }
      return { out: { [PROPERTY_MARKER]: tags, [VALUE_KEY]: out }, tags: {} };
    };

    const recurse = (
      v: unknown,
      tag: string | null,
    ): { out: unknown; tags: Record<string, string> } => {
      if (tag !== null) {
        if (typeof v === "bigint") {
          return { out: v.toString(), tags: { [TAG_PATH]: "bigint" } };
        }
        if (typeof v === "number") {
          return {
            out: v,
            tags: {
              [TAG_PATH]: Number.isNaN(v) ? "nan" : v === Infinity ? "infinity" : "-infinity",
            },
          };
        }
        if (v instanceof Date) {
          return { out: v.toISOString(), tags: { [TAG_PATH]: "date" } };
        }
        if (v instanceof Map) {
          return arrayTransform(Array.from(v), "map", cache);
        }
        if (v instanceof Set) {
          return arrayTransform(Array.from(v), "set", cache);
        }
        if (v instanceof RegExp) {
          return { out: [v.source, v.flags], tags: { [TAG_PATH]: "regexp" } };
        }
        if (v instanceof Uint8Array) {
          return {
            out: { data: Array.from(v) },
            tags: { [TAG_PATH]: Buffer.isBuffer(v) ? "buffer" : "uint8array" },
          };
        }
      }

      if (v === null || typeof v !== "object") {
        return { out: v, tags: {} };
      }

      const cached = cache.get(v);
      if (cached !== undefined) {
        return { out: cached, tags: tag === null ? {} : { [TAG_PATH]: tag } };
      }

      if (isPlainObject(v)) {
        const out: Record<string, unknown> = {};
        const tags: Record<string, string> = {};
        cache.set(v, out);
        for (const key of Object.keys(v)) {
          const { out: child, tags: childTags } = recurse(v[key], detectType(v[key]));
          out[key] = child;
          if (hasOwn(childTags, TAG_PATH)) {
            tags[key] = childTags[TAG_PATH];
          } else {
            for (const childPath of Object.keys(childTags)) {
              tags[`${key}/${childPath}`] = childTags[childPath];
            }
          }
        }
        if (Object.keys(tags).length > 0) {
          out[PROPERTY_MARKER] = tags;
        }
        return { out, tags: tag === null ? {} : { [TAG_PATH]: tag } };
      }

      if (Array.isArray(v)) {
        return arrayTransform(v, tag, cache);
      }

      return { out: v, tags: tag === null ? {} : { [TAG_PATH]: tag } };
    };

    const { out, tags } = recurse(value, null);
    if (isPlainObject(value) && !hasOwn(value, PROPERTY_MARKER)) {
      return out;
    }
    return { [PROPERTY_MARKER]: tags, [VALUE_KEY]: out };
  };

  return { transform };
}

function detectType(value: unknown): string | null {
  if (value instanceof Date) return "date";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  if (value instanceof RegExp) return "regexp";
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "infinity";
    if (value === -Infinity) return "-infinity";
  }
  if (Buffer.isBuffer(value)) return "buffer";
  if (value instanceof Uint8Array) return "uint8array";
  return null;
}

function reviveTree(node: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (node === null || typeof node !== "object") return node;

  if (
    hasOwn(node, PROPERTY_MARKER) &&
    hasOwn(node, VALUE_KEY) &&
    typeof (node as Record<string, unknown>)[PROPERTY_MARKER] === "object" &&
    (node as Record<string, unknown>)[PROPERTY_MARKER] !== null
  ) {
    const props = (node as Record<string, unknown>)[PROPERTY_MARKER] as Record<string, string>;
    const inner = reviveTree((node as Record<string, unknown>)[VALUE_KEY], seen);
    const replaced = reviveAtPaths(inner, props);
    return replaced === TAG_PATH ? inner : replaced;
  }

  if (hasOwn(node, PROPERTY_MARKER)) {
    if (seen.has(node)) return node;
    seen.add(node);

    const props = (node as Record<string, unknown>)[PROPERTY_MARKER];
    if (props === null || typeof props !== "object") {
      delete (node as Record<string, unknown>)[PROPERTY_MARKER];
      return node;
    }

    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (key === PROPERTY_MARKER) continue;
      (node as Record<string, unknown>)[key] = reviveTree(
        (node as Record<string, unknown>)[key],
        seen,
      );
    }
    reviveAtPaths(node, props as Record<string, string>);
    delete (node as Record<string, unknown>)[PROPERTY_MARKER];
    return node;
  }

  if (Array.isArray(node)) {
    if (seen.has(node)) return node;
    seen.add(node);
    for (let i = 0; i < node.length; i++) {
      node[i] = reviveTree(node[i], seen);
    }
    return node;
  }

  if (isPlainObject(node)) {
    if (seen.has(node)) return node;
    seen.add(node);
    for (const key of Object.keys(node)) {
      node[key] = reviveTree(node[key], seen);
    }
  }

  return node;
}

// Apply one level's `__$p` tag map: for each path, walk down (each segment is
// a bare property name or array index) and rebuild the tagged value. Deeper
// levels were already revived by `reviveTree`, so the tagged node's contents
// are fully restored before it is rewrapped. Returns a replacement value when
// the empty-path tag (the level itself) was revived, or a sentinel otherwise.
function reviveAtPaths(node: unknown, props: Record<string, string>): unknown {
  let replaced: unknown = TAG_PATH;
  const paths = Object.keys(props).sort((a, b) => b.split("/").length - a.split("/").length);
  for (const path of paths) {
    const tag = props[path];
    let current: unknown = node;
    if (path === TAG_PATH) {
      const next = reviveTypeAtPath(node, path, tag, current);
      if (next !== TAG_PATH) replaced = next;
      continue;
    }
    for (const segment of path.split("/")) {
      if (current === null || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    reviveTypeAtPath(node, path, tag, current);
  }
  return replaced;
}

function reviveTypeAtPath(root: unknown, path: string, tag: string, value: unknown): unknown {
  const set = (next: unknown): unknown => {
    if (path === TAG_PATH) {
      return next;
    }
    const segments = path.split("/");
    let current: unknown = root;
    for (let i = 0; i < segments.length - 1; i++) {
      if (current === null || typeof current !== "object") return TAG_PATH;
      current = (current as Record<string, unknown>)[segments[i]];
    }
    if (current !== null && typeof current === "object") {
      (current as Record<string, unknown>)[segments[segments.length - 1]] = next;
    }
    return TAG_PATH;
  };

  let result: unknown = TAG_PATH;
  if (tag === "date") {
    if (typeof value === "string") result = set(new Date(value));
  } else if (tag === "buffer" || tag === "uint8array") {
    if (
      value !== null &&
      typeof value === "object" &&
      Array.isArray((value as { data?: unknown }).data)
    ) {
      const data = (value as { data: number[] }).data;
      result = set(tag === "buffer" ? Buffer.from(data) : Uint8Array.from(data));
    }
  } else if (tag === "map") {
    if (Array.isArray(value)) result = set(new Map(value as [unknown, unknown][]));
  } else if (tag === "set") {
    if (Array.isArray(value)) result = set(new Set(value));
  } else if (tag === "regexp") {
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
      result = set(new RegExp(value[0], value[1]));
    }
  } else if (tag === "bigint") {
    if (typeof value === "string") result = set(BigInt(value));
  } else if (tag === "nan") {
    result = set(NaN);
  } else if (tag === "infinity") {
    result = set(Infinity);
  } else if (tag === "-infinity") {
    result = set(-Infinity);
  }
  return result;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * JSON de/serializer over a byte `KvTable`.
 *
 * `K` is the key type (`Buffer`, `string`, or a union of both) and `V` the
 * value type; `get`/`getOr` return `V` (or `V | null`) accordingly. Values
 * round-trip through `serializeJSON`/`deserializeJSON`, so `Date`s, `Buffer`s
 * and other non-JSON types survive; string keys are utf8-encoded. `get`
 * returns `null` both when a key is missing and when the stored value is the
 * JSON literal `null` — use `getOr` to distinguish. `get` throws a
 * `SyntaxError` if the stored bytes are not valid JSON.
 *
 * Writes are async — they commit off the JS thread on the store's writer
 * queue. Reads are sync. On one table, writes resolve in call order.
 */
export class JsonTable<K extends JsonKey = JsonKey, V = unknown> {
  /** Underlying byte table. */
  readonly raw: KvTable;

  constructor(table: KvTable) {
    this.raw = table;
  }

  /** Name of the underlying table. */
  get name(): string {
    return this.raw.name;
  }

  /** JSON-stringify `value` and store it under `key`. */
  async put(key: K, value: V): Promise<void> {
    await this.raw.put(toKeyBytes(key), serializeJSON(value));
  }

  /** Fetch and JSON-parse a value. Returns `null` when the key is missing or the value is JSON `null`. */
  get(key: K): V | null {
    const bytes = this.raw.get(toKeyBytes(key));
    return bytes === null ? null : deserializeJSON<V>(bytes);
  }

  /** Fetch and parse, or return `fallback` when the key is missing. */
  getOr(key: K, fallback: V): V {
    const value = this.get(key);
    return value === null ? fallback : value;
  }

  /** JSON-encode and insert many entries in a single transaction. */
  async putBatch(entries: JsonEntry<K, V>[]): Promise<void> {
    await this.raw.putBatch(
      entries.map(({ key, value }) => ({
        key: toKeyBytes(key),
        value: serializeJSON(value),
      })),
    );
  }

  /** Fetch many keys in one transaction; one value per key, in order, `null` for missing keys. */
  async getBatch(keys: K[]): Promise<(V | null)[]> {
    const values = await this.raw.getBatch(keys.map(toKeyBytes));
    return values.map((v) => (v == null ? null : deserializeJSON<V>(v)));
  }

  /** Delete a key. Resolves `true` if the key existed. */
  async delete(key: K): Promise<boolean> {
    return this.raw.delete(toKeyBytes(key));
  }

  /** Alias of `delete`. */
  async remove(key: K): Promise<boolean> {
    return this.raw.remove(toKeyBytes(key));
  }
}

/** Encode a string key to utf8 bytes; pass `Buffer` keys through unchanged. */
function toKeyBytes(key: JsonKey): Buffer {
  return typeof key === "string" ? Buffer.from(key, "utf8") : key;
}
