use napi::bindgen_prelude::*;
use napi_derive::napi;
use redb::{Database, ReadableTable, TableDefinition};
use std::sync::Arc;

const TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("kv");

fn to_napi_err<E: std::fmt::Display>(e: E) -> Error {
    Error::from_reason(e.to_string())
}

#[napi]
pub struct KvStore {
    db: Arc<Database>,
}

#[napi]
impl KvStore {
    /// Open (or create) a redb database file at the given path.
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let db = Database::create(path).map_err(to_napi_err)?;

        // Ensure the table exists on first open.
        let txn = db.begin_write().map_err(to_napi_err)?;
        {
            let _ = txn.open_table(TABLE).map_err(to_napi_err)?;
        }
        txn.commit().map_err(to_napi_err)?;

        Ok(Self { db: Arc::new(db) })
    }

    /// Fetch a value by key. Returns null if the key doesn't exist.
    #[napi]
    pub fn get(&self, key: Buffer) -> Result<Option<Buffer>> {
        let txn = self.db.begin_read().map_err(to_napi_err)?;
        let table = txn.open_table(TABLE).map_err(to_napi_err)?;
        let key_slice: &[u8] = &key;

        match table.get(key_slice).map_err(to_napi_err)? {
            Some(v) => Ok(Some(Buffer::from(v.value().to_vec()))),
            None => Ok(None),
        }
    }

    /// Insert or overwrite a key.
    #[napi]
    pub fn put(&self, key: Buffer, value: Buffer) -> Result<()> {
        let txn = self.db.begin_write().map_err(to_napi_err)?;
        {
            let mut table = txn.open_table(TABLE).map_err(to_napi_err)?;
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
        let txn = self.db.begin_write().map_err(to_napi_err)?;
        let existed;
        {
            let mut table = txn.open_table(TABLE).map_err(to_napi_err)?;
            let key_slice: &[u8] = &key;
            existed = table.remove(key_slice).map_err(to_napi_err)?.is_some();
        }
        txn.commit().map_err(to_napi_err)?;
        Ok(existed)
    }

    /// Batch-insert multiple key/value pairs in a single transaction.
    /// Much faster than calling put() in a loop when writing many keys.
    #[napi]
    pub fn put_batch(&self, entries: Vec<KvEntry>) -> Result<()> {
        let txn = self.db.begin_write().map_err(to_napi_err)?;
        {
            let mut table = txn.open_table(TABLE).map_err(to_napi_err)?;
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
