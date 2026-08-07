// Minimal ambient types for the Bun built-in modules used by the benchmark.
// LMDB is the external `lmdb` npm package (Bun's `bun:lmdb` is just an alias
// for it and is unreliable when a project has node_modules without `lmdb`);
// it ships its own types. `bun:sqlite` is a real Bun built-in, but its types
// are limited, so only the surface the benchmark touches is declared here.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): SQLStatement;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
  }

  export class SQLStatement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  }
}
