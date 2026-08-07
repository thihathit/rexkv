import { performance } from "node:perf_hooks";
import { open as lmdbOpen } from "lmdb";
import { Database as SQLiteDatabase, SQLStatement } from "bun:sqlite";
import type { KvDurability } from "rexkv";
import { KvStore, tempDbPath } from "./native.ts";

// ---------------------------------------------------------------------------
// Configuration (override on the CLI: `bun bench.ts --n 50000 --valuesize 256`)
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const N = Number(arg("n", "10000"));
const KEY_SIZE = Number(arg("keysize", "16"));
const VALUE_SIZE = Number(arg("valuesize", "64"));
const BATCH = Number(arg("batch", "1000"));
const ROUNDS = Math.max(1, Number(arg("rounds", "1")));
const REXKV_DURABILITIES = arg("durability", "eventual,immediate").split(",").filter(Boolean);

if (!Number.isInteger(N) || N <= 0) throw new Error("--n must be a positive integer");
if (!Number.isInteger(BATCH) || BATCH <= 0) throw new Error("--batch must be a positive integer");

// ---------------------------------------------------------------------------
// Common engine interface. Every engine implements the same four workloads so
// the comparison is apples-to-apples: single ops (awaited to commit) and
// chunked batch ops.
// ---------------------------------------------------------------------------

interface KvEntry {
  key: Buffer;
  value: Buffer;
}

interface BenchEngine {
  readonly name: string;
  open(): void;
  put(key: Buffer, value: Buffer): Promise<void>;
  putBatch(entries: KvEntry[]): Promise<void>;
  get(key: Buffer): unknown;
  getBatch(keys: Buffer[]): Promise<unknown>;
  close(): Promise<void>;
}

function lmdbEngine(path: string, name: string): BenchEngine {
  let db: ReturnType<typeof lmdbOpen>;
  return {
    name,
    open() {
      db = lmdbOpen(path, {
        mapSize: 1024 * 1024 * 1024,
        keyEncoding: "binary",
        encoding: "binary",
      });
    },
    async put(key, value) {
      db.put(key, value);
      await db.flushed;
    },
    async putBatch(entries) {
      for (const e of entries) db.put(e.key, e.value);
      await db.flushed;
    },
    get(key) {
      return db.get(key) ?? null;
    },
    async getBatch(keys) {
      return db.getMany(keys);
    },
    async close() {
      await db.flushed;
      db.close();
    },
  };
}

function sqliteEngine(path: string): BenchEngine {
  let db: SQLiteDatabase;
  let upsert: SQLStatement;
  let selOne: SQLStatement;
  const selManyCache = new Map<number, SQLStatement>();
  return {
    name: "sqlite",
    open() {
      db = new SQLiteDatabase(path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("CREATE TABLE IF NOT EXISTS kv (k BLOB PRIMARY KEY, v BLOB) WITHOUT ROWID");
      upsert = db.prepare(
        "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      );
      selOne = db.prepare("SELECT v FROM kv WHERE k = ?");
    },
    async put(key, value) {
      upsert.run(key, value);
    },
    async putBatch(entries) {
      const bulk = db.transaction((list: KvEntry[]) => {
        for (const e of list) upsert.run(e.key, e.value);
      });
      bulk(entries);
    },
    get(key) {
      const row = selOne.get(key);
      return (row?.v as Buffer | Uint8Array | undefined) ?? null;
    },
    async getBatch(keys) {
      let stmt = selManyCache.get(keys.length);
      if (!stmt) {
        const placeholders = "?" + ",?".repeat(keys.length - 1);
        stmt = db.prepare(`SELECT v FROM kv WHERE k IN (${placeholders})`);
        selManyCache.set(keys.length, stmt);
      }
      return stmt.all(...keys);
    },
    async close() {
      db.close();
    },
  };
}

function rexkvEngine(
  path: string,
  durability: "immediate" | "eventual" | "none",
  label: string,
): BenchEngine {
  let kv: InstanceType<typeof KvStore>;
  let table: ReturnType<InstanceType<typeof KvStore>["openTable"]>;
  return {
    name: `rexkv (${label})`,
    open() {
      kv = new KvStore(path, { durability: durability as KvDurability, maxQueue: 4096 });
      table = kv.openTable("kv");
    },
    async put(key, value) {
      await table.put(key, value);
    },
    async putBatch(entries) {
      await table.putBatch(entries);
    },
    get(key) {
      return table.get(key);
    },
    async getBatch(keys) {
      return table.getBatch(keys);
    },
    async close() {
      await kv.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic key generation and a value we never mutate.
// ---------------------------------------------------------------------------

function makeKeys(n: number, size: number): Buffer[] {
  const keys: Buffer[] = [];
  let seed = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    const b = Buffer.allocUnsafe(size);
    for (let j = 0; j < size; j++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      b[j] = seed & 0xff;
    }
    keys.push(b);
  }
  return keys;
}

const keys = makeKeys(N, KEY_SIZE);
const warmupKeys = makeKeys(2000, KEY_SIZE);
const value = Buffer.allocUnsafe(VALUE_SIZE);
for (let i = 0; i < VALUE_SIZE; i++) value[i] = i & 0xff;

let sink = 0; // consumed at the end so reads are never optimized away

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Workload = "write_seq" | "write_batch" | "read_seq" | "read_batch";
const WORKLOADS: Workload[] = ["write_seq", "write_batch", "read_seq", "read_batch"];

async function runWorkload(engine: BenchEngine, w: Workload): Promise<void> {
  switch (w) {
    case "write_seq":
      for (const k of keys) await engine.put(k, value);
      break;
    case "write_batch":
      for (const c of chunks(keys, BATCH)) await engine.putBatch(c.map((key) => ({ key, value })));
      break;
    case "read_seq":
      for (const k of keys) {
        const v = engine.get(k);
        if (v && typeof v === "object") sink += (v as { byteLength?: number }).byteLength ?? 0;
      }
      break;
    case "read_batch":
      for (const c of chunks(keys, BATCH)) {
        const v = await engine.getBatch(c);
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item && typeof item === "object")
              sink += (item as { byteLength?: number }).byteLength ?? 0;
          }
        }
      }
      break;
  }
}

function median(xs: number[]): number {
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

async function timeWorkload(engine: BenchEngine, w: Workload): Promise<number> {
  const samples: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    await runWorkload(engine, w);
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

async function benchEngine(engine: BenchEngine): Promise<Record<Workload, number>> {
  engine.open();
  try {
    for (const k of warmupKeys) await engine.put(k, value);
    for (const k of warmupKeys) {
      const v = engine.get(k);
      if (v && typeof v === "object") sink += (v as { byteLength?: number }).byteLength ?? 0;
    }
    const results = {} as Record<Workload, number>;
    for (const w of WORKLOADS) results[w] = await timeWorkload(engine, w);
    return results;
  } finally {
    await engine.close();
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmtOps(ops: number): string {
  return Math.round(ops).toLocaleString("en-US");
}

function fmtMs(ms: number): string {
  return `${ms < 1000 ? ms.toFixed(1) : (ms / 1000).toFixed(2)}${ms < 1000 ? "ms" : "s"}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main() {
  const engines: BenchEngine[] = [
    lmdbEngine(tempDbPath(), "lmdb"),
    sqliteEngine(tempDbPath()),
    ...REXKV_DURABILITIES.map((d) =>
      rexkvEngine(tempDbPath(), d as "immediate" | "eventual" | "none", d),
    ),
  ];

  const colW = WORKLOADS.map((w) => Math.max(w.length, 13) + 8);
  console.log("=== rexkv vs LMDB vs BunSQLite ===");
  console.log(
    `${process.platform} ${process.arch} · bun ${process.versions.bun} · n=${N} keysize=${KEY_SIZE} valuesize=${VALUE_SIZE} batch=${BATCH} rounds=${ROUNDS}`,
  );
  console.log();
  const header = `  ${pad("engine", 20)} ${WORKLOADS.map((w, i) => pad(`${w} (ops/s)`, colW[i])).join(" ")} ${pad("total", 8)}`;
  console.log(header);
  console.log("  " + "-".repeat(20 + colW.reduce((a, b) => a + b, 0) + WORKLOADS.length + 8));

  const totals: Record<string, number> = {};
  const perWorkload: Record<Workload, { engine: string; ms: number }[]> = {
    write_seq: [],
    write_batch: [],
    read_seq: [],
    read_batch: [],
  };

  for (const engine of engines) {
    const results = await benchEngine(engine);
    const total = Object.values(results).reduce((a, b) => a + b, 0);
    totals[engine.name] = total;
    const cells = WORKLOADS.map((w) => {
      const ops = (N / results[w]) * 1000;
      return pad(`${fmtOps(ops)} (${fmtMs(results[w])})`, colW[WORKLOADS.indexOf(w)]);
    }).join(" ");
    console.log(`  ${pad(engine.name, 20)} ${cells} ${pad(`${(total / 1000).toFixed(2)}s`, 8)}`);
    for (const w of WORKLOADS) perWorkload[w].push({ engine: engine.name, ms: results[w] });
  }

  // Relative comparison, LMDB as the baseline (per workload).
  console.log();
  console.log("relative to lmdb (×)");
  console.log(`  ${pad("engine", 20)} ${WORKLOADS.map((w, i) => pad(w, colW[i])).join(" ")}`);
  for (const engine of engines) {
    const cells = WORKLOADS.map((w, i) => {
      const lmdbMs = perWorkload[w].find((r) => r.engine === "lmdb")!.ms;
      const row = perWorkload[w].find((r) => r.engine === engine.name)!;
      const ratio = lmdbMs / row.ms;
      return pad(ratio.toFixed(2), colW[i]);
    }).join(" ");
    console.log(`  ${pad(engine.name, 20)} ${cells}`);
  }

  console.log();
  console.log(`verify (sink=${sink.toLocaleString("en-US")})`);
  console.log("done");
}

main();
