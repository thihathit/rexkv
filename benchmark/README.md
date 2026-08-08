# Benchmark: rexkv vs LMDB vs BunSQLite

Compares three embedded storage engines as used from Bun on this machine:

| Engine   | Backing store                                                                                                         | Writes                                                                         | Reads                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `lmdb`   | npm [`lmdb`](https://www.npmjs.com/package/lmdb) (lmdb-js; `bun:lmdb` is only an alias for it)                        | async commit to mmap; `await db.flushed` per op/chunk                          | sync `get`, `getMany`                      |
| `sqlite` | [`bun:sqlite`](https://bun.com/docs/api/sqlite) (WAL, `synchronous=NORMAL`, `mmap_size=256MB`, `WITHOUT ROWID` table) | sync statements; chunked writes in one `db.transaction`                        | sync `get`, one `IN (...)` query per chunk |
| `rexkv`  | this repo's native addon (`redb`)                                                                                     | `put`/`putBatch`, awaited; rows for `durability: "eventual"` and `"immediate"` | sync `get`, async `getBatch`               |

## Run

```bash
cd benchmark
bun install
bun run bench            # all benchmarks, sequentially
bun run bench:speed      # only rexkv vs LMDB vs BunSQLite (bench.ts)
bun run bench -- --n 50000 --valuesize 256 --durability eventual
bun run bench -- --rounds 3     # median of 3 per workload
bun run bench:compression       # only rexkv compression "none" vs "lz4" (compression.ts)
```

`bun run bench` runs `all.ts`, which runs the speed comparison (`bench.ts`)
then the compression comparison (`compression.ts`) in one process. Defaults:
`n=10_000`, `keysize=16`, `valuesize=64`, `batch=1000`, `rounds=1`,
`durability=eventual,immediate` (speed bench only).

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
- `rss (MB)` is the peak process-RSS delta over the pre-open baseline, sampled
  every 10ms plus once after each workload — a rough footprint signal. See the
  fairness notes for what it does and doesn't include.

## Sample run

Machine-specific; from this repo's dev box (WSL2 — Linux x64, bun 1.3.14,
defaults, `rounds=3`):

```
=== rexkv vs LMDB vs BunSQLite ===
linux x64 · bun 1.3.14 · n=10000 keysize=16 valuesize=64 batch=1000 rounds=3

  engine               write_seq (ops/s)     write_batch (ops/s)   read_seq (ops/s)      read_batch (ops/s)    total    rss (MB)
  ----------------------------------------------------------------------------------------------------------------------------
  lmdb                 3,517 (2.84s)         331,022 (30.2ms)      529,070 (18.9ms)      338,908 (29.5ms)      2.92s    21.8
  sqlite               69,401 (144.1ms)      401,701 (24.9ms)      118,356 (84.5ms)      527,122 (19.0ms)      0.27s    18.1
  rexkv (eventual)     3,676 (2.72s)         262,133 (38.1ms)      352,356 (28.4ms)      362,629 (27.6ms)      2.81s    15.9
  rexkv (immediate)    3,660 (2.73s)         259,198 (38.6ms)      381,154 (26.2ms)      378,178 (26.4ms)      2.82s    12.2
```

Reading: single-key `write_seq` is dominated by per-write commit/round-trip cost
(all three engines are close except sqlite's autocommit); bulk writes and bulk
reads favor the batched APIs; rexkv's sync `get` matches LMDB and beats sqlite
row parsing. See the fairness notes before drawing conclusions.

## Compression (lz4) sample run

`bun run bench:compression` compares the same rexkv store with
`compression: "none"` vs `"lz4"` — awaited `put` throughput, `getBatch`
throughput, and on-disk db size. Compressible values are JSON with a repeated
4KiB payload (realistic blobs); incompressible values are deterministic random
bytes. CPU-bound rows use `durability: "none"` to isolate the compression cost
from fsync; `immediate` rows reflect the default per-commit fsync.

```
=== rexkv compression: none vs lz4 ===
linux x64 · bun 1.3.14 · 4KiB values, n=2000 (64KiB rows use n=400)

mode                data            dur        |  throughput
───────────────────────────────────────────────────────────────────────────────────
none  / compressible    none        put   1.9k/s  get  75.3k/s  db 132108KiB  (16.40x of raw)
lz4   / compressible    none        put   2.2k/s  get  52.5k/s  db  66316KiB  ( 8.23x of raw)
none  / incompressible  none        put   2.0k/s  get  71.5k/s  db 132108KiB  (16.49x of raw)
lz4   / incompressible  none        put   2.1k/s  get  74.3k/s  db 132108KiB  (16.49x of raw)
none  / compressible    immediate   put   3.0k/s  get  43.9k/s  db  33420KiB  ( 4.15x of raw)
lz4   / compressible    immediate   put   3.7k/s  get  72.9k/s  db   3600KiB  ( 0.45x of raw)
none  / compressible    none        put   1.1k/s  get   2.4k/s  db 132108KiB  ( 5.16x of raw)  64KiB values
lz4   / compressible    none        put   2.5k/s  get   6.4k/s  db  16972KiB  ( 0.66x of raw)  64KiB values
```

Reading: lz4 is never slower — put is equal or faster in every row (the 64KiB
case is ~2×). At the default `immediate` durability the compressed file is
~9× smaller (0.45× of the raw bytes, vs 4.15× for none-mode) and reads speed
up as the working set shrinks (43.9k → 72.9k/s in this run). Incompressible
data is stored raw, so there is no size change and only a little CPU overhead.
The `none`-durability db sizes are not meaningful: redb grows the file until a
higher-durability commit.

Caveats: single-run numbers, machine-specific, and get-throughput has visible
run-to-run variance (page cache from the previous scenario is still resident).
No `--rounds` support — repeat the command for a spread. Note also that
compression is a per-store policy — a file written with `"lz4"` must be
reopened with `"lz4"` (see API.md).

## Fairness notes

- **Durability differs by design.** `rexkv immediate` fsyncs every commit,
  so its `write_seq` is the slowest by far — that's the honest cost of
  per-write durability. `lmdb` default commits to the mmap without fsync
  (OS writes back lazily); `sqlite` WAL `NORMAL` fsyncs the WAL per commit;
  `rexkv eventual` drops per-commit fsync. For bulk writes the difference
  shrinks because fsync happens once per chunk.
- **SQLite uses mmap too.** SQLite ships with `mmap_size` = 0 (disabled); the
  benchmark enables `PRAGMA mmap_size = 256MB` so it maps its DB file like
  LMDB and rexkv instead of reading through the page-cache/read() path.
- **`rss (MB)` is a rough signal.** It's the peak process-RSS delta over the
  baseline sampled every 10ms + once per workload, so it includes evictable OS
  page cache for the engine's DB files as well as its own allocations — it is
  not a precise heap count. Because engines run sequentially, the delta
  attributes the footprint to each engine's own files.
- Numbers are machine-specific (page cache, filesystem, CPU). This sample was
  captured under **WSL2** (a VM sharing the Windows host's CPU/RAM, so results
  vary run to run); the DB temp dirs live on the WSL ext4 filesystem. Run on
  your own hardware; use `--rounds 3` and larger `--n` for stabler results.
