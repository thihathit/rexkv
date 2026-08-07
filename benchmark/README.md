# Benchmark: rexkv vs LMDB vs BunSQLite

Compares three embedded storage engines as used from Bun on this machine:

| Engine   | Backing store                                                                                      | Writes                                                                         | Reads                                      |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `lmdb`   | npm [`lmdb`](https://www.npmjs.com/package/lmdb) (lmdb-js; `bun:lmdb` is only an alias for it)     | async commit to mmap; `await db.flushed` per op/chunk                          | sync `get`, `getMany`                      |
| `sqlite` | [`bun:sqlite`](https://bun.com/docs/api/sqlite) (WAL, `synchronous=NORMAL`, `WITHOUT ROWID` table) | sync statements; chunked writes in one `db.transaction`                        | sync `get`, one `IN (...)` query per chunk |
| `rexkv`  | this repo's native addon (`redb`)                                                                  | `put`/`putBatch`, awaited; rows for `durability: "eventual"` and `"immediate"` | sync `get`, async `getBatch`               |

## Run

```bash
cd benchmark
bun install
bun run bench            # defaults below
bun run bench -- --n 50000 --valuesize 256 --durability eventual
bun run bench -- --rounds 3     # median of 3 per workload
```

Defaults: `n=10_000`, `keysize=16`, `valuesize=64`, `batch=1000`, `rounds=1`,
`durability=eventual,immediate`.

## Methodology

- Each engine gets its own database in a temp dir (cleaned up on exit); the
  `rexkv` native addon is built on first run if `rust/*.node` is missing.
- Keys are deterministic pseudo-random buffers, identical across engines.
  A 2000-key warmup (write + read) runs first to warm page caches, JIT, and
  any lazy init.
- Four workloads, run in the same order for every engine:
  - `write_seq` — N single-key writes, each awaited to commit.
  - `write_batch` — N writes in chunks of `batch`, each chunk committed.
  - `read_seq` — N single-key sync reads.
  - `read_batch` — N reads in chunks (`getMany` / `IN (...)` / `getBatch`).
- Timings are median wall-clock per workload with `performance.now()`; the
  table shows ops/s (and ms), the second table shows each engine relative to
  `lmdb` per workload. Values read are summed into a sink printed at the end
  so reads can't be optimized away.

## Sample run

Machine-specific; from this repo's dev box (Linux x64, bun 1.3.14, defaults):

```
=== rexkv vs LMDB vs BunSQLite ===
linux x64 · bun 1.3.14 · n=10000 keysize=16 valuesize=64 batch=1000 rounds=1

  engine               write_seq (ops/s)     write_batch (ops/s)   read_seq (ops/s)      read_batch (ops/s)    total
  -------------------------------------------------------------------------------------------------------------------
  lmdb                 3,218 (3.11s)         152,879 (65.4ms)      376,193 (26.6ms)      222,422 (45.0ms)      3.24s
  sqlite               54,778 (182.6ms)      397,902 (25.1ms)      121,558 (82.3ms)      451,935 (22.1ms)      0.31s
  rexkv (eventual)     3,487 (2.87s)         218,818 (45.7ms)      403,805 (24.8ms)      401,979 (24.9ms)      2.96s
  rexkv (immediate)    3,380 (2.96s)         227,637 (43.9ms)      442,329 (22.6ms)      375,463 (26.6ms)      3.05s
```

Reading: single-key `write_seq` is dominated by per-write commit/round-trip cost
(all three engines are close except sqlite's autocommit); bulk writes and bulk
reads favor the batched APIs; rexkv's sync `get` matches LMDB and beats sqlite
row parsing. See the fairness notes before drawing conclusions.

## Fairness notes

- **Durability differs by design.** `rexkv immediate` fsyncs every commit,
  so its `write_seq` is the slowest by far — that's the honest cost of
  per-write durability. `lmdb` default commits to the mmap without fsync
  (OS writes back lazily); `sqlite` WAL `NORMAL` fsyncs the WAL per commit;
  `rexkv eventual` drops per-commit fsync. For bulk writes the difference
  shrinks because fsync happens once per chunk.
- Numbers are machine-specific (page cache, filesystem, CPU). Run on your
  own hardware; use `--rounds 3` and larger `--n` for stabler results.
