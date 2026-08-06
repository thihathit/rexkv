# Tests

Each subfolder is a self-contained Bun project: build the native addon, compile it into a
single-file executable (SFE), run a smoke test. `bun run test` from the folder does it all
(and builds `../../rust` first if needed).

## What these are

**SFE bundling tests, not functional tests.** They verify the `red-kv` `.node` addon embeds
and loads in a compiled Bun executable — nothing more. Store correctness is only smoke-checked
(a `put`/`get`/`putBatch`/`delete` round-trip printed to console).

| Project | Coverage |
| --- | --- |
| `bun-sfe/` | `.node` inlined via a custom Bun plugin + `createRequire`/`type: "file"` (fails outside a bundler). |
| `bun-sfe-build_and_run/` | Current variant: `bun build --compile` embeds `native/red-kv.node` in Bun's VFS, then runs it. |
| `functional/` | **The functional suite.** Agnostic `node:test` tests that run under both Node (`node --test`) and Bun (`bun test`) against the native addon (loaded via `createRequire`, no bundling): lazy `openTable`/null reads, write ordering, close semantics (drain, reject-after-close), durability, backpressure, multi-store isolation, and `JsonTable`/serializer round-trips. `bun run test` runs both runners.
