// Bench: rexkv compression "none" vs "lz4" — write throughput, read throughput, db size.
// Run: `bun bench-compression.ts` (builds the native addon on first run via ./native.ts).
import { performance } from "node:perf_hooks";
import { statSync } from "node:fs";
import type { KvCompression, KvDurability } from "rexkv";
import { KvStore, tempDbPath } from "./native.ts";

type Mode = "none" | "lz4";
type Dur = "none" | "immediate";

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeValue(kind: "compressible" | "incompressible", size: number, seed: number): Buffer {
  if (kind === "compressible") {
    return Buffer.from(
      JSON.stringify({ seed, body: "abcd".repeat(Math.ceil(size / 4)).slice(0, size) }),
    );
  }
  const rnd = mulberry32(seed);
  return Buffer.from(Array.from({ length: size }, () => Math.floor(rnd() * 256)));
}

function fmtRate(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0);
}

async function scenario(
  label: string,
  mode: Mode,
  dur: Dur,
  kind: "compressible" | "incompressible",
  size: number,
  n: number,
): Promise<void> {
  const dbPath = tempDbPath();
  const kv = new KvStore(dbPath, {
    putCompression: mode as KvCompression,
    durability: dur as KvDurability,
    maxQueue: 4096,
  });
  const t = kv.openTable("kv");
  const values = Array.from({ length: n }, (_, i) => makeValue(kind, size, i));

  // Warm up (queue + page cache).
  for (let i = 0; i < 100; i++) await t.put(Buffer.from(String(i)), values[i]);

  let t0 = performance.now();
  for (let i = 0; i < n; i++) await t.put(Buffer.from(String(i)), values[i]);
  const putMs = performance.now() - t0;

  // Read back all keys in batches of 100.
  const batch = 100;
  t0 = performance.now();
  for (let start = 0; start < n; start += batch) {
    const keys = Array.from({ length: Math.min(batch, n - start) }, (_, j) =>
      Buffer.from(String(start + j)),
    );
    await t.getBatch(keys);
  }
  const getMs = performance.now() - t0;

  await kv.close();
  const dbSize = statSync(dbPath).size;
  const raw = values.reduce((acc, v) => acc + v.byteLength + 6, 0);

  const puts = (n / putMs) * 1000;
  const gets = (n / getMs) * 1000;
  const ratio = (dbSize / raw).toFixed(2);
  console.log(
    `${label.padEnd(24)} put ${fmtRate(puts).padStart(6)}/s  get ${fmtRate(gets).padStart(6)}/s  db ${(dbSize / 1024).toFixed(0).padStart(6)}KiB  (${ratio}x of raw)`,
  );
}

export async function main() {
  console.log("=== rexkv compression: none vs lz4 ===");
  console.log(
    `${process.platform} ${process.arch} · bun ${process.versions.bun} · 4KiB values, n=2000 (64KiB rows use n=400)`,
  );
  console.log();
  console.log("mode                data            dur        |  throughput");
  console.log("─".repeat(100));

  // CPU-bound (durability "none") isolates the compression cost from fsync.
  await scenario("none  / compressible", "none", "none", "compressible", 4096, 2000);
  await scenario("lz4   / compressible", "lz4", "none", "compressible", 4096, 2000);
  await scenario("none  / incompressible", "none", "none", "incompressible", 4096, 2000);
  await scenario("lz4   / incompressible", "lz4", "none", "incompressible", 4096, 2000);

  // Realistic durability "immediate" (default) — fsync per commit dominates.
  await scenario("none  / compressible", "none", "immediate", "compressible", 4096, 2000);
  await scenario("lz4   / compressible", "lz4", "immediate", "compressible", 4096, 2000);

  // Big-value probe (64KiB, compressible), CPU-bound.
  await scenario("none  / compressible", "none", "none", "compressible", 65536, 400);
  await scenario("lz4   / compressible", "lz4", "none", "compressible", 65536, 400);
}

if (import.meta.main) {
  await main();
}
