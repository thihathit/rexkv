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
| types | `KvStore`, `KvTable`, `KvEntry` | Re-exported from `types.d.ts`. |

## Semantics

- Keys/values are raw bytes. Content equality decides a hit; ordering is byte-lexicographic (redb B-tree).
- Every call runs its own transaction; all ops are synchronous.
- Tables share one database file; identical names open the same table.

## Roadmap

- Range / iteration API (ordered scan over byte keys — pairs naturally with UUIDv7 keys).
- Serialization helpers (JSON) — optional; caller can wrap in TS today.
- Async variants of `put`/`putBatch` for large batches.
