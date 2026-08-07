# Rex KV

Fast embedded KV store (powered by [redb](https://redb.org)) for Bun/Node, distributed as prebuilt `.node` binaries.
Consuming projects never run Rust or `napi build`. Everything is compiled once, in this repo, ahead of time.

This repo ships exactly two things:

1. **The API layer** (`ts/`) — an npm package exposing `getKvStore(module)`,
   which unwraps the `KvStore` constructor from a `.node` module you've
   already loaded.
2. **The prebuilt binaries** — platform-specific `.node` files, built by
   `.github/workflows/release.yml` and attached to GitHub [Releases](../../releases).

See [API.md](./API.md) for the full API reference — the native bindings
(`KvStore`, `KvTable`) and the TS library (`JsonTable`, `serializeJSON`,
`deserializeJSON`).

## Benchmarks

`benchmark/` compares rexkv against [`bun:lmdb`](https://bun.com/docs/api/lmdb)
and [`bun:sqlite`](https://bun.com/docs/api/sqlite) on sequential and batched
writes and reads. `cd benchmark && bun install && bun run bench`.

## Contributing

Only relevant if you're changing `rust/src/lib.rs` itself:

```bash
cd rust
bun install
bun run build
```

The build compiles for your current host only and regenerates
`ts/types.d.ts`.

Versions are pinned for reproducible builds: `bun` is pinned in
`rust/.bun-version`, Rust is pinned in
`rust/rust-toolchain.toml` (read automatically by rustup), and
`rust/Cargo.lock`, `rust/bun.lock`, and `ts/bun.lock` are committed. CI
(`release.yml`) uses the same pins, so a rebuild at any point produces the
same output.

Cross-compiling all 5 targets locally has real OS constraints (macOS
targets need a Mac, `win32-x64-msvc` needs Windows or `cargo-xwin`,
`linux-arm64` needs `cross`). That's exactly why `release.yml` exists.
Push a `v*` tag and let CI produce all 5 for you.
