# red-kv API

Native bindings (Rust + redb) exposed as a `.node` addon. Bytes in / bytes out — serialization (JSON etc.) is the caller's job.

## Exports

The `.node` module exports one class: `KvStore`.

## `KvStore`

| Member | Signature | Description |
| --- | --- | --- |
| constructor | `new KvStore(path: string)` | Open (or create) a redb database file. |
| `openTable` | `openTable(name: string): KvTable` | Open (or create) a named table. |
| `close` | `close(): void` | Close the database; every later op (store or any table) throws `"database is closed"`. |

## `KvTable`

| Member | Signature | Description |
| --- | --- | --- |
| `name` | `get name(): string` | Table name. |
| `get` | `get(key: Buffer): Buffer \| null` | Fetch value, or `null` if key missing. |
| `put` | `put(key: Buffer, value: Buffer): void` | Insert or overwrite. |
| `delete` | `delete(key: Buffer): boolean` | Remove key; returns `true` if it existed. |
| `remove` | `remove(key: Buffer): boolean` | Alias of `delete`. |
| `putBatch` | `putBatch(entries: KvEntry[]): void` | Insert many entries in one transaction. |

## `KvEntry`

```ts
interface KvEntry { key: Buffer; value: Buffer }
```

## TS layer (`ts/`)

| Member | Signature | Description |
| --- | --- | --- |
| `getKvStore` | `getKvStore(module: unknown): typeof KvStore` | Unwrap the `KvStore` constructor from a loaded `.node` module. |
| `serializeJSON` | `serializeJSON(value: unknown): Buffer` | Date-aware JSON encode to bytes. |
| `deserializeJSON` | `deserializeJSON<T>(bytes: Buffer): T` | Date-aware JSON decode from bytes. |
| `JsonTable` | `new JsonTable(table: KvTable)` | JSON de/serializer wrapper over a byte table; delegates to the functions above. |
| types | `KvStore`, `KvTable`, `KvEntry`, `JsonKey`, `JsonEntry` | Re-exported from `types.d.ts` / defined in `index.ts`. |

### Serialization

- `serializeJSON` / `deserializeJSON` keep `Date` round-trips working without a full pre-walk or a parse-time reviver. During the single `JSON.stringify` pass the replacer reads `this[key]` (the pre-`toJSON` value) to spot `Date`s and record their paths.
- For plain-object values containing `Date`s, the paths are stored in a `"_$properties"` metadata key, e.g. `{ "at": "...", "_$properties": { "at": "date" } }`; `deserializeJSON` revives only those paths and deletes the key. Values without `Date`s get no metadata and no extra work. Paths use `/`-separated segments with `~0`/`~1` escaping.
- Roots that can't carry `"_$properties"` (arrays, `Date` roots, or data that already uses that key) fall back to inline `{ "$date": isoString }` markers, revived by a `JSON.parse` reviver.
- `Buffer`s inside a value become `{ type: "Buffer", data: [...] }` and do NOT come back as `Buffer`s.
- `Symbol`/`undefined` values are not JSON-serializable (follow `JSON.stringify` semantics).

## `JsonTable<K, V>` (ts/)

`K extends JsonKey = JsonKey` is the key type (`Buffer`, `string`, or a union), `V = unknown` the value type; `get`/`getOr` return `V` / `V | null`.

| Member | Signature | Description |
| --- | --- | --- |
| `raw` | `readonly raw: KvTable` | Underlying byte table. |
| `name` | `get name(): string` | Table name. |
| `put` | `put(key: K, value: V): void` | `JSON.stringify` and store; string keys are utf8-encoded. |
| `get` | `get(key: K): V \| null` | `JSON.parse` the value; `null` if key missing or value is JSON `null`. |
| `getOr` | `getOr(key: K, fallback: V): V` | Fallback when the key is missing. |
| `putBatch` | `putBatch(entries: { key: K; value: V }[]): void` | Encode and insert in one transaction. |
| `delete` / `remove` | `delete(key: K): boolean` | Delete a key; passthrough to the byte table. |

## Semantics

- Keys/values are raw bytes. Content equality decides a hit; ordering is byte-lexicographic (redb B-tree).
- Every call runs its own transaction; all ops are synchronous.
- Tables share one database file; identical names open the same table.
- JSON values round-trip through `serializeJSON`/`deserializeJSON` (Date-aware); `get` throws `SyntaxError` on non-JSON bytes.

## Roadmap

- Range / iteration API (ordered scan over byte keys — pairs naturally with UUIDv7 keys).
- Async variants of `put`/`putBatch` for large batches.
