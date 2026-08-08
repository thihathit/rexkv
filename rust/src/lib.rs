use napi::bindgen_prelude::*;
use napi::JsValue;
use napi_derive::napi;
use redb::{Database, Durability, TableDefinition, TableError};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::oneshot;

/// One reply channel from a queued job back to the awaiting JS promise.
type Reply<T> = oneshot::Sender<std::result::Result<T, String>>;

/// The open database, shared by the store and every table it hands out.
/// Set to `None` by `KvStore.close()`, which makes every later operation fail.
struct SharedDb {
    db: Mutex<Option<Arc<Database>>>,
    durability: Durability,
    compression: bool,
}

impl SharedDb {
    fn get(&self) -> Result<Arc<Database>> {
        self.db
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::from_reason("database is closed"))
    }

    fn get_string(&self) -> std::result::Result<Arc<Database>, String> {
        self.db
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "database is closed".to_string())
    }
}

fn to_napi_err<E: std::fmt::Display>(e: E) -> Error {
    Error::from_reason(e.to_string())
}

/// Value storage format. With compression enabled, every stored value carries a
/// 1-byte tag so reads can tell raw and LZ4-compressed values apart. With it
/// disabled, values are stored as-is (byte-identical to pre-compression files).
const TAG_RAW: u8 = 0x00;
const TAG_LZ4: u8 = 0x01;

/// Encode a value for storage. Compresses only when it actually shrinks, so
/// small or incompressible values stay raw (plus the 1-byte tag).
fn encode_value(compress: bool, value: &[u8]) -> Vec<u8> {
    if !compress {
        return value.to_vec();
    }
    let compressed = lz4_flex::block::compress_prepend_size(value);
    if compressed.len() + 1 < value.len() {
        let mut out = Vec::with_capacity(compressed.len() + 1);
        out.push(TAG_LZ4);
        out.extend_from_slice(&compressed);
        out
    } else {
        let mut out = Vec::with_capacity(value.len() + 1);
        out.push(TAG_RAW);
        out.extend_from_slice(value);
        out
    }
}

/// Decode a stored value back to its original bytes. Only a store opened with
/// compression interprets tags; untagged values (or a none-mode store) are
/// returned as-is. `compression` must match when reopening a database file.
fn decode_value(
    compress: bool,
    stored: &[u8],
) -> std::result::Result<Vec<u8>, String> {
    if !compress {
        return Ok(stored.to_vec());
    }
    match stored.first() {
        Some(&TAG_RAW) => Ok(stored[1..].to_vec()),
        Some(&TAG_LZ4) => lz4_flex::block::decompress_size_prepended(&stored[1..])
            .map_err(|e| e.to_string()),
        _ => Ok(stored.to_vec()),
    }
}

/// A write-side operation, applied in order by the single writer thread.
enum Job {
    Put {
        table: String,
        key: Vec<u8>,
        value: Vec<u8>,
        reply: Reply<()>,
    },
    Delete {
        table: String,
        key: Vec<u8>,
        reply: Reply<bool>,
    },
    PutBatch {
        table: String,
        entries: Vec<(Vec<u8>, Vec<u8>)>,
        reply: Reply<()>,
    },
    GetBatch {
        table: String,
        keys: Vec<Vec<u8>>,
        reply: Reply<Vec<Option<Vec<u8>>>>,
    },
    Close {
        reply: Reply<()>,
    },
}

fn worker_put(
    db: &Database,
    durability: Durability,
    compress: bool,
    table: &str,
    key: &[u8],
    value: &[u8],
) -> std::result::Result<(), String> {
    let mut txn = db.begin_write().map_err(|e| e.to_string())?;
    txn.set_durability(durability);
    let stored = encode_value(compress, value);
    {
        let mut t = txn
            .open_table(TableDefinition::<&[u8], &[u8]>::new(table))
            .map_err(|e| e.to_string())?;
        t.insert(key, stored.as_slice()).map_err(|e| e.to_string())?;
    }
    txn.commit().map_err(|e| e.to_string())
}

fn worker_delete(
    db: &Database,
    durability: Durability,
    table: &str,
    key: &[u8],
) -> std::result::Result<bool, String> {
    let mut txn = db.begin_write().map_err(|e| e.to_string())?;
    txn.set_durability(durability);
    let existed;
    {
        let mut t = txn
            .open_table(TableDefinition::<&[u8], &[u8]>::new(table))
            .map_err(|e| e.to_string())?;
        existed = t.remove(key).map_err(|e| e.to_string())?.is_some();
    }
    txn.commit().map_err(|e| e.to_string())?;
    Ok(existed)
}

fn worker_put_batch(
    db: &Database,
    durability: Durability,
    compress: bool,
    table: &str,
    entries: &[(Vec<u8>, Vec<u8>)],
) -> std::result::Result<(), String> {
    let mut txn = db.begin_write().map_err(|e| e.to_string())?;
    txn.set_durability(durability);
    {
        let mut t = txn
            .open_table(TableDefinition::<&[u8], &[u8]>::new(table))
            .map_err(|e| e.to_string())?;
        for (key, value) in entries {
            let stored = encode_value(compress, value);
            t.insert(key.as_slice(), stored.as_slice()).map_err(|e| e.to_string())?;
        }
    }
    txn.commit().map_err(|e| e.to_string())
}

fn worker_get_batch(
    db: &Database,
    compress: bool,
    table: &str,
    keys: &[Vec<u8>],
) -> std::result::Result<Vec<Option<Vec<u8>>>, String> {
    let txn = db.begin_read().map_err(|e| e.to_string())?;
    let t = match txn.open_table(TableDefinition::<&[u8], &[u8]>::new(table)) {
        Ok(t) => t,
        Err(TableError::TableDoesNotExist(_)) => return Ok(vec![None; keys.len()]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        match t.get(key.as_slice()).map_err(|e| e.to_string())? {
            Some(v) => out.push(Some(decode_value(compress, v.value())?)),
            None => out.push(None),
        }
    }
    Ok(out)
}

fn writer_loop(shared: Arc<SharedDb>, rx: Receiver<Job>) {
    let durability = shared.durability;
    let compression = shared.compression;
    let mut closing = false;
    while let Ok(job) = rx.recv() {
        if closing {
            // After Close, the writer stays alive to drain the channel and
            // reject everything still queued, so no promise is ever left
            // pending. It exits once the last Sender is dropped.
            let reason = "database is closed".to_string();
            match job {
                Job::Put { reply, .. } => {
                    let _ = reply.send(Err(reason));
                }
                Job::Delete { reply, .. } => {
                    let _ = reply.send(Err(reason));
                }
                Job::PutBatch { reply, .. } => {
                    let _ = reply.send(Err(reason));
                }
                Job::GetBatch { reply, .. } => {
                    let _ = reply.send(Err(reason));
                }
                Job::Close { reply } => {
                    let _ = reply.send(Err(reason));
                }
            }
            continue;
        }
        match job {
            Job::Put { table, key, value, reply } => {
                let res = shared
                    .get_string()
                    .and_then(|db| worker_put(&db, durability, compression, &table, &key, &value));
                let _ = reply.send(res);
            }
            Job::Delete { table, key, reply } => {
                let res = shared
                    .get_string()
                    .and_then(|db| worker_delete(&db, durability, &table, &key));
                let _ = reply.send(res);
            }
            Job::PutBatch { table, entries, reply } => {
                let res = shared.get_string().and_then(|db| {
                    worker_put_batch(&db, durability, compression, &table, &entries)
                });
                let _ = reply.send(res);
            }
            Job::GetBatch { table, keys, reply } => {
                let res = shared.get_string().and_then(|db| {
                    worker_get_batch(&db, compression, &table, &keys)
                });
                let _ = reply.send(res);
            }
            Job::Close { reply } => {
                let _ = reply.send(Ok(()));
                closing = true;
            }
        }
    }
}

async fn await_reply<T>(rx: oneshot::Receiver<std::result::Result<T, String>>) -> Result<T> {
    rx.await
        .map_err(|_| Error::from_reason("database is closed"))?
        .map_err(Error::from_reason)
}

/// Wrap a raw Promise from `Env::spawn_future`/`PromiseRaw::reject` in a
/// returnable `ObjectRef`, which converts to a JS value (and releases its
/// reference) when the napi call returns it.
fn promise_to_js<T>(raw: PromiseRaw<'_, T>) -> Result<ObjectRef<false>> {
    let value = raw.value();
    Ok(Object::from_raw(value.env, value.value).create_ref::<false>()?)
}

/// Enqueue a job synchronously on the JS thread, so queued order is exactly
/// the caller's order. Returns a Promise that settles when the writer thread
/// replies. If the enqueue itself fails (queue full, database closed) an
/// already-rejected Promise is returned — callers always receive a Promise,
/// never a synchronous throw.
fn enqueue_promise<T>(
    env: Env,
    reply: oneshot::Receiver<std::result::Result<T, String>>,
    enqueue: impl FnOnce() -> Result<()>,
) -> Result<ObjectRef<false>>
where
    T: 'static + Send + ToNapiValue,
{
    if let Err(e) = enqueue() {
        let raw = PromiseRaw::<'_, T>::reject(&env, e)?;
        return promise_to_js(raw);
    }
    let raw = env.spawn_future::<T, _>(async move { await_reply(reply).await })?;
    promise_to_js(raw)
}

/// Durable-write policy for every write transaction.
#[napi(string_enum)]
pub enum KvDurability {
    /// Nothing is fsynced; fastest, but a crash can lose commits and the
    /// database file grows until a higher-durability commit.
    #[napi(value = "none")]
    None,
    /// Commits are queued for persistence; durable "some time after" commit.
    #[napi(value = "eventual")]
    Eventual,
    /// Every commit is fsynced before the promise resolves (default).
    #[napi(value = "immediate")]
    Immediate,
}

/// Compression policy for stored values.
#[napi(string_enum)]
pub enum KvCompression {
    /// Store values as-is (default).
    #[napi(value = "none")]
    None,
    /// Compress value bytes with LZ4 before storing; decompressed on read.
    #[napi(value = "lz4")]
    Lz4,
}

#[napi(object)]
pub struct KvStoreOptions {
    /// Fsync policy for write transactions. Defaults to `Immediate`.
    pub durability: Option<KvDurability>,
    /// Max number of queued write jobs before `put`/`putBatch`/`delete`
    /// reject with a "queue is full" error (backpressure). Defaults to 1024.
    pub max_queue: Option<u32>,
    /// Value compression. Defaults to `None`.
    pub compression: Option<KvCompression>,
}

#[napi]
pub struct KvStore {
    shared: Arc<SharedDb>,
    sender: SyncSender<Job>,
}

impl KvStore {
    fn enqueue(&self, job: Job) -> Result<()> {
        match self.sender.try_send(job) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(Error::from_reason(
                "rexkv write queue is full; await some pending writes before issuing more",
            )),
            Err(TrySendError::Disconnected(_)) => Err(Error::from_reason("database is closed")),
        }
    }
}

#[napi]
impl KvStore {
    /// Open (or create) a redb database file at the given path.
    #[napi(constructor)]
    pub fn new(path: String, options: Option<KvStoreOptions>) -> Result<Self> {
        let (durability, max_queue, compression) = match options {
            Some(o) => (
                match o.durability {
                    Some(KvDurability::None) => Durability::None,
                    Some(KvDurability::Eventual) => Durability::Eventual,
                    Some(KvDurability::Immediate) | None => Durability::Immediate,
                },
                o.max_queue.unwrap_or(1024) as usize,
                matches!(o.compression, Some(KvCompression::Lz4)),
            ),
            None => (Durability::Immediate, 1024, false),
        };

        let db = Database::create(path).map_err(to_napi_err)?;
        let shared = Arc::new(SharedDb {
            db: Mutex::new(Some(Arc::new(db))),
            durability,
            compression,
        });

        let (sender, receiver) = sync_channel(max_queue.max(1));
        let worker_shared = shared.clone();
        thread::Builder::new()
            .name("rexkv-writer".to_string())
            .spawn(move || writer_loop(worker_shared, receiver))
            .map_err(to_napi_err)?;

        Ok(Self { shared, sender })
    }

    /// Drain the write queue, flush, and close the database. Resolves once
    /// every previously queued write has committed. Any later call on this
    /// store — or on a table it returned — throws "database is closed".
    #[napi(ts_return_type = "Promise<void>")]
    pub fn close(&self, env: Env) -> Result<ObjectRef<false>> {
        let (tx, rx) = oneshot::channel();
        if let Err(e) = self.enqueue(Job::Close { reply: tx }) {
            let raw = PromiseRaw::<'_, ()>::reject(&env, e)?;
            return promise_to_js(raw);
        }
        let shared = self.shared.clone();
        let raw = env.spawn_future::<(), _>(async move {
            await_reply(rx).await?;
            *shared.db.lock().unwrap() = None;
            Ok(())
        })?;
        promise_to_js(raw)
    }

    /// Open a named table and return a handle scoped to it. Sync — no I/O
    /// happens here. The table itself is created lazily by the first write
    /// to it, and reads on a never-written table return null. Tables share
    /// the same underlying database file.
    #[napi]
    pub fn open_table(&self, name: String) -> Result<KvTable> {
        self.shared.get()?;
        Ok(KvTable {
            shared: self.shared.clone(),
            sender: self.sender.clone(),
            name,
        })
    }
}

#[napi]
pub struct KvTable {
    shared: Arc<SharedDb>,
    sender: SyncSender<Job>,
    name: String,
}

impl KvTable {
    fn enqueue(&self, job: Job) -> Result<()> {
        match self.sender.try_send(job) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(Error::from_reason(
                "rexkv write queue is full; await some pending writes before issuing more",
            )),
            Err(TrySendError::Disconnected(_)) => Err(Error::from_reason("database is closed")),
        }
    }
}

#[napi]
impl KvTable {
    /// Name of this table.
    #[napi(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Fetch a value by key. Returns null if the key doesn't exist.
    /// Sync — the hot read path.
    #[napi]
    pub fn get(&self, key: Buffer) -> Result<Option<Buffer>> {
        let db = self.shared.get()?;
        let txn = db.begin_read().map_err(to_napi_err)?;
        let table = match txn.open_table(TableDefinition::<&[u8], &[u8]>::new(&self.name)) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(to_napi_err(e)),
        };
        let key_slice: &[u8] = &key;

        match table.get(key_slice).map_err(to_napi_err)? {
            Some(v) => Ok(Some(Buffer::from(
                decode_value(self.shared.compression, v.value()).map_err(to_napi_err)?,
            ))),
            None => Ok(None),
        }
    }

    /// Insert or overwrite a key, off the JS thread.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn put(&self, env: Env, key: Buffer, value: Buffer) -> Result<ObjectRef<false>> {
        let (tx, rx) = oneshot::channel();
        enqueue_promise(
            env,
            rx,
            || {
                self.enqueue(Job::Put {
                    table: self.name.clone(),
                    key: key.to_vec(),
                    value: value.to_vec(),
                    reply: tx,
                })
            },
        )
    }

    /// Delete a key. Resolves true if the key existed.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn delete(&self, env: Env, key: Buffer) -> Result<ObjectRef<false>> {
        let (tx, rx) = oneshot::channel();
        enqueue_promise(
            env,
            rx,
            || {
                self.enqueue(Job::Delete {
                    table: self.name.clone(),
                    key: key.to_vec(),
                    reply: tx,
                })
            },
        )
    }

    /// Delete a key. Resolves true if the key existed. Alias of `delete`.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn remove(&self, env: Env, key: Buffer) -> Result<ObjectRef<false>> {
        self.delete(env, key)
    }

    /// Batch-insert multiple key/value pairs in a single transaction.
    /// Much faster than calling put() in a loop when writing many keys.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn put_batch(&self, env: Env, entries: Vec<KvEntry>) -> Result<ObjectRef<false>> {
        let entries: Vec<(Vec<u8>, Vec<u8>)> = entries
            .into_iter()
            .map(|e| (e.key.to_vec(), e.value.to_vec()))
            .collect();
        let (tx, rx) = oneshot::channel();
        enqueue_promise(
            env,
            rx,
            || {
                self.enqueue(Job::PutBatch {
                    table: self.name.clone(),
                    entries,
                    reply: tx,
                })
            },
        )
    }

    /// Fetch many keys in one transaction. Resolves one value per key,
    /// in order; `null` for missing keys.
    #[napi(ts_return_type = "Promise<Array<Buffer | undefined | null>>")]
    pub fn get_batch(&self, env: Env, keys: Vec<Buffer>) -> Result<ObjectRef<false>> {
        let keys: Vec<Vec<u8>> = keys.into_iter().map(|k| k.to_vec()).collect();
        let (tx, rx) = oneshot::channel();
        if let Err(e) = self.enqueue(Job::GetBatch {
            table: self.name.clone(),
            keys,
            reply: tx,
        }) {
            let raw = PromiseRaw::<Vec<Option<Buffer>>>::reject(&env, e)?;
            return promise_to_js(raw);
        }
        let raw = env.spawn_future::<Vec<Option<Buffer>>, _>(async move {
            let values: Vec<Option<Vec<u8>>> = await_reply(rx).await?;
            Ok(values.into_iter().map(|v| v.map(Buffer::from)).collect::<Vec<_>>())
        })?;
        promise_to_js(raw)
    }
}

#[napi(object)]
pub struct KvEntry {
    pub key: Buffer,
    pub value: Buffer,
}
