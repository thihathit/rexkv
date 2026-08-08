// Run every benchmark sequentially. `bun run bench` in the benchmark dir.
import { main as speedBench } from "./bench-speed.ts";
import { main as compressionBench } from "./bench-compression.ts";

await speedBench();
console.log();
console.log("─".repeat(100));
console.log();
await compressionBench();
