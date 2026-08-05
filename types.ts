export interface KvEntry {
  key: Buffer;
  value: Buffer;
}

export interface RedKvInstance {
  get(key: Buffer): Buffer | null;
  put(key: Buffer, value: Buffer): void;
  delete(key: Buffer): boolean;
  putBatch(entries: KvEntry[]): void;
}

export interface RedKvConstructor {
  new (path: string): RedKvInstance;
}

/** Platform/arch key as produced by `${process.platform}-${process.arch}` */
export type RedKvPlatformKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-x64";
