use napi::bindgen_prelude::*;
use napi_derive::napi;
use redb::{Database, TableDefinition};
use std::sync::{Arc, Mutex};

/// The open database, shared by the store and every table it hands out.
/// Set to `None` by `KvStore.close()`, which makes every later operation fail.
struct SharedDb {
    db: Mutex<Option<Arc<Database>>>,
}

impl SharedDb {
    fn get(&self) -> Result<Arc<Database>> {
        self.db
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::from_reason("database is closed"))
    }
}

fn to_napi_err<E: std::fmt::Display>(e: E) -> Error {
    Error::from_reason(e.to_string())
}

#[napi]
pub struct KvStore {
    shared: Arc<SharedDb>,
}

#[napi]
impl KvStore {
    /// Open (or create) a redb database file at the given path.
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let db = Database::create(path).map_err(to_napi_err)?;

        Ok(Self {
            shared: Arc::new(SharedDb {
                db: Mutex::new(Some(Arc::new(db))),
            }),
        })
    }

    /// Close the database and release the file handle. Any later call on this
    /// store — or on a table it returned — will throw "database is closed".
    #[napi]
    pub fn close(&self) {
        *self.shared.db.lock().unwrap() = None;
    }

    /// Open (or create) a named table (a redb table) and return a handle
    /// scoped to it. Tables share the same underlying database file.
    #[napi]
    pub fn open_table(&self, name: String) -> Result<KvTable> {
        let db = self.shared.get()?;

        let txn = db.begin_write().map_err(to_napi_err)?;
        {
            let _ = txn
                .open_table(TableDefinition::<&[u8], &[u8]>::new(&name))
                .map_err(to_napi_err)?;
        }
        txn.commit().map_err(to_napi_err)?;

        Ok(KvTable {
            shared: self.shared.clone(),
            name,
        })
    }
}

#[napi]
pub struct KvTable {
    shared: Arc<SharedDb>,
    name: String,
}

#[napi]
impl KvTable {
    /// Name of this table.
    #[napi(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Fetch a value by key. Returns null if the key doesn't exist.
    #[napi]
    pub fn get(&self, key: Buffer) -> Result<Option<Buffer>> {
        let db = self.shared.get()?;
        let txn = db.begin_read().map_err(to_napi_err)?;
        let table = txn
            .open_table(TableDefinition::<&[u8], &[u8]>::new(&self.name))
            .map_err(to_napi_err)?;
        let key_slice: &[u8] = &key;

        match table.get(key_slice).map_err(to_napi_err)? {
            Some(v) => Ok(Some(Buffer::from(v.value().to_vec()))),
            None => Ok(None),
        }
    }

    /// Insert or overwrite a key.
    #[napi]
    pub fn put(&self, key: Buffer, value: Buffer) -> Result<()> {
        let db = self.shared.get()?;
        let txn = db.begin_write().map_err(to_napi_err)?;
        {
            let mut table = txn
                .open_table(TableDefinition::<&[u8], &[u8]>::new(&self.name))
                .map_err(to_napi_err)?;
            let key_slice: &[u8] = &key;
            let val_slice: &[u8] = &value;
            table.insert(key_slice, val_slice).map_err(to_napi_err)?;
        }
        txn.commit().map_err(to_napi_err)?;
        Ok(())
    }

    /// Delete a key. Returns true if the key existed.
    #[napi]
    pub fn delete(&self, key: Buffer) -> Result<bool> {
        let db = self.shared.get()?;
        let txn = db.begin_write().map_err(to_napi_err)?;
        let existed;
        {
            let mut table = txn
                .open_table(TableDefinition::<&[u8], &[u8]>::new(&self.name))
                .map_err(to_napi_err)?;
            let key_slice: &[u8] = &key;
            existed = table.remove(key_slice).map_err(to_napi_err)?.is_some();
        }
        txn.commit().map_err(to_napi_err)?;
        Ok(existed)
    }

    /// Delete a key. Returns true if the key existed. Alias of `delete`.
    #[napi]
    pub fn remove(&self, key: Buffer) -> Result<bool> {
        self.delete(key)
    }

    /// Batch-insert multiple key/value pairs in a single transaction.
    /// Much faster than calling put() in a loop when writing many keys.
    #[napi]
    pub fn put_batch(&self, entries: Vec<KvEntry>) -> Result<()> {
        let db = self.shared.get()?;
        let txn = db.begin_write().map_err(to_napi_err)?;
        {
            let mut table = txn
                .open_table(TableDefinition::<&[u8], &[u8]>::new(&self.name))
                .map_err(to_napi_err)?;
            for entry in entries {
                let key_slice: &[u8] = &entry.key;
                let val_slice: &[u8] = &entry.value;
                table.insert(key_slice, val_slice).map_err(to_napi_err)?;
            }
        }
        txn.commit().map_err(to_napi_err)?;
        Ok(())
    }
}

#[napi(object)]
pub struct KvEntry {
    pub key: Buffer,
    pub value: Buffer,
}
