import type { KvStore, KvTable } from "./types.d.ts";

export type { KvEntry, KvStore, KvTable } from "./types.d.ts";

/** Key accepted by `JsonTable`; strings are utf8-encoded to bytes. */
export type JsonKey = Buffer | string;

/** Entry accepted by `JsonTable.putBatch`. */
export interface JsonEntry<K extends JsonKey = JsonKey, V = unknown> {
  key: K;
  value: V;
}

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

/**
 * JSON-encode a JS value to bytes. `Date` instances are marked as
 * `{ "$date": isoString }` so `deserializeJSON` can bring them back as real
 * `Date`s. Note that `Buffer` values become `{ type: "Buffer", data: [...] }`
 * and do NOT come back as `Buffer`s.
 */
/**
 * JSON-encode a JS value to bytes. `Date` instances round-trip back to real
 * `Date`s: their paths are recorded in a `"_$properties"` metadata key
 * (plain-object values) so no metadata is added when there are no `Date`s.
 * Note that `Buffer` values become `{ type: "Buffer", data: [...] }` and do
 * NOT come back as `Buffer`s.
 */
export function serializeJSON(value: unknown): Buffer {
  const { replacer, props } = makeReplacer();
  const text = JSON.stringify(value, replacer);

  if (Object.keys(props).length === 0) {
    return Buffer.from(text, "utf8");
  }

  if (isPlainObject(value) && !hasOwn(value, PROPERTY_MARKER)) {
    return Buffer.from(JSON.stringify({ ...value, [PROPERTY_MARKER]: props }), "utf8");
  }

  return Buffer.from(JSON.stringify(markDates(value, new WeakSet())), "utf8");
}

/**
 * Decode bytes produced by `serializeJSON` (or any JSON) back to a JS value.
 * Values whose path is listed in the `"_$properties"` metadata are revived
 * as `Date`s. Throws a `SyntaxError` if the bytes are not valid JSON.
 */
export function deserializeJSON<T = unknown>(bytes: Buffer): T {
  const text = bytes.toString("utf8");
  const value = JSON.parse(text) as unknown;

  if (isPlainObject(value) && isPlainObject(value[PROPERTY_MARKER])) {
    const props = value[PROPERTY_MARKER] as Record<string, string>;
    if (Object.keys(props).length > 0) {
      reviveProperties(value, props);
      return value as T;
    }
  }

  if (text.includes('"$date"')) {
    return JSON.parse(text, dateReviver) as T;
  }

  return value as T;
}

const PROPERTY_MARKER = "_$properties";

// A JSON.stringify replacer never sees a `Date`: Date.prototype.toJSON runs
// first, turning it into an ISO string. But `this[key]` is the value BEFORE
// toJSON, so the replacer can still spot `Date`s and record their paths while
// stringify does its single traversal — no pre-walk or copy needed.
function makeReplacer(): {
  replacer: (this: Record<string, unknown>, key: string, value: unknown) => unknown;
  props: Record<string, string>;
} {
  const pathFor = new WeakMap<object, string>();
  const props: Record<string, string> = {};

  const replacer = function (this: Record<string, unknown>, key: string, value: unknown): unknown {
    const thisObj: unknown = this;
    const parentPath =
      thisObj !== null && typeof thisObj === "object" ? (pathFor.get(thisObj as object) ?? "") : "";
    const path =
      key === ""
        ? ""
        : parentPath === ""
          ? escapeSegment(key)
          : `${parentPath}/${escapeSegment(key)}`;
    if (
      thisObj !== null &&
      typeof thisObj === "object" &&
      (thisObj as Record<string, unknown>)[key] instanceof Date
    ) {
      props[path] = "date";
    }
    if (value !== null && typeof value === "object") {
      pathFor.set(value as object, path);
    }
    return value;
  };

  return { replacer, props };
}

function reviveProperties(root: Record<string, unknown>, props: Record<string, string>): void {
  for (const path of Object.keys(props)) {
    if (props[path] === "date" && path !== "") {
      const target = getByPath(root, path);
      if (typeof target === "string") {
        setByPath(root, path, new Date(target));
      }
    }
  }
  delete root[PROPERTY_MARKER];
}

function getByPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[unescapeSegment(segment)];
  }
  return current;
}

function setByPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split("/");
  let current: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    current = (current as Record<string, unknown>)[unescapeSegment(segments[i])] as Record<
      string,
      unknown
    >;
  }
  current[unescapeSegment(segments[segments.length - 1])] = value;
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Fallback for roots that can't carry `"_$properties"` (arrays, `Date`s,
// objects that already use that key): inline `{ "$date": iso }` markers.
function markDates(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = markDates(value[i], seen);
    }
    seen.delete(value);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = markDates(value[key], seen);
    }
    seen.delete(value);
    return out;
  }
  return value;
}

function dateReviver(key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>).$date === "string"
  ) {
    return new Date((value as { $date: string }).$date);
  }
  return value;
}

/**
 * JSON de/serializer over a byte `KvTable`.
 *
 * `K` is the key type (`Buffer`, `string`, or a union of both) and `V` the
 * value type; `get`/`getOr` return `V` (or `V | null`) accordingly. Values
 * round-trip through `serializeJSON`/`deserializeJSON`, so `Date`s survive;
 * string keys are utf8-encoded. `get` returns `null` both when a key is
 * missing and when the stored value is the JSON literal `null` — use `getOr`
 * to distinguish. `get` throws a `SyntaxError` if the stored bytes are not
 * valid JSON.
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
  put(key: K, value: V): void {
    this.raw.put(toKeyBytes(key), serializeJSON(value));
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
  putBatch(entries: JsonEntry<K, V>[]): void {
    this.raw.putBatch(
      entries.map(({ key, value }) => ({
        key: toKeyBytes(key),
        value: serializeJSON(value),
      })),
    );
  }

  /** Delete a key. Returns `true` if the key existed. */
  delete(key: K): boolean {
    return this.raw.delete(toKeyBytes(key));
  }

  /** Alias of `delete`. */
  remove(key: K): boolean {
    return this.raw.remove(toKeyBytes(key));
  }
}

/** Encode a string key to utf8 bytes; pass `Buffer` keys through unchanged. */
function toKeyBytes(key: JsonKey): Buffer {
  return typeof key === "string" ? Buffer.from(key, "utf8") : key;
}
