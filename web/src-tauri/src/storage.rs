use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use uuid::Uuid;

pub const DATABASE_FILE: &str = "data.sqlite3";
pub const MARKER_FILE: &str = "infinite-canvas.json";
pub const IMPORT_INCOMPLETE_FILE: &str = ".import-incomplete";
pub const BLOB_CONFLICT: &str = "相同存储键已有不同文件，已拒绝覆盖";
pub const BLOB_MODIFIED: &str = "已存媒体被外部修改，已拒绝覆盖";
const SCHEMA_VERSION: i64 = 1;

type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    format: String,
    version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("infinite-canvas-storage-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }
    fn put(storage: &Storage, key: &str, bytes: &[u8]) -> Result<BlobInfo> {
        let upload = storage.create_blob_temp("image_files", key, None)?;
        fs::write(&upload.path, bytes).map_err(io_error)?;
        storage.commit_blob(upload, "image/png")
    }

    #[test]
    fn failed_record_batch_is_atomic_and_namespace_isolated() {
        let root = TestDirectory::new();
        let storage = Storage::open(&root.0).unwrap();
        storage.records_batch(vec![RecordMutation::Set { namespace: "plugin:first".into(), key: "shared".into(), value: "first".into() }], None, None).unwrap();
        let before = storage.revision().unwrap();
        storage.records_batch(vec![RecordMutation::Set { namespace: "plugin:first".into(), key: "shared".into(), value: "first".into() }], None, None).unwrap();
        assert_eq!(storage.revision().unwrap(), before);
        let result = storage.records_batch(vec![
            RecordMutation::Set { namespace: "plugin:second".into(), key: "shared".into(), value: "second".into() },
            RecordMutation::Set { namespace: "unknown".into(), key: "bad".into(), value: "bad".into() },
        ], Some(before), None);
        assert!(result.is_err());
        assert_eq!(storage.records_get("plugin:first", "shared").unwrap().as_deref(), Some("first"));
        assert_eq!(storage.records_get("plugin:second", "shared").unwrap(), None);
        assert_eq!(storage.revision().unwrap(), before);
    }

    #[test]
    fn media_identity_never_overwrites_and_reopens_on_disk() {
        let root = TestDirectory::new();
        let storage = Storage::open(&root.0).unwrap();
        let original = put(&storage, "image:one", b"original").unwrap();
        assert_eq!(put(&storage, "image:one", b"original").unwrap().sha256, original.sha256);
        assert!(put(&storage, "image:one", b"changed").is_err());
        let (path, _) = storage.resolve_blob("image_files", "image:one").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"original");
        storage.flush().unwrap();
        drop(storage);
        let reopened = Storage::open(&root.0).unwrap();
        assert_eq!(reopened.blob_list(None).unwrap().len(), 1);
    }

    #[test]
    fn maintenance_and_cleanup_preserve_references_and_unknown_files() {
        let root = TestDirectory::new();
        let storage = Storage::open(&root.0).unwrap();
        put(&storage, "image:keep", b"keep").unwrap();
        put(&storage, "image:delete", b"delete").unwrap();
        storage.records_batch(vec![
            RecordMutation::Set { namespace: "image_previews".into(), key: "image:keep".into(), value: "preview".into() },
            RecordMutation::Set { namespace: "image_previews".into(), key: "image:delete".into(), value: "preview".into() },
        ], None, None).unwrap();
        fs::write(root.0.join("media").join("user-file.txt"), b"user data").unwrap();
        let upload = storage.create_blob_temp("media_files", "video:pending", None).unwrap();
        assert!(storage.begin_maintenance().is_err());
        drop(upload);
        let snapshot = storage.begin_maintenance().unwrap();
        assert!(put(&storage, "image:blocked", b"blocked").is_err());
        storage.end_maintenance(&snapshot.token).unwrap();
        let references = vec![BlobRef { namespace: "image_files".into(), key: "image:keep".into() }];
        let preview = storage.cleanup_preview(references.clone(), None).unwrap();
        assert_eq!(preview.files.len(), 1);
        assert!(storage.cleanup_commit(references.clone(), preview.revision + 1, None).is_err());
        let removed = storage.cleanup_commit(references, preview.revision, None).unwrap();
        assert_eq!(removed.bytes, 6);
        assert!(storage.resolve_blob("image_files", "image:keep").is_ok());
        assert_eq!(storage.records_get("image_previews", "image:keep").unwrap().as_deref(), Some("preview"));
        assert_eq!(storage.records_get("image_previews", "image:delete").unwrap(), None);
        assert_eq!(fs::read(root.0.join("media").join("user-file.txt")).unwrap(), b"user data");
    }

    #[test]
    fn unknown_directory_is_rejected_without_creating_database() {
        let root = TestDirectory::new();
        fs::write(root.0.join("personal.txt"), b"preserve").unwrap();
        assert!(Storage::open(&root.0).is_err());
        assert!(!root.0.join(DATABASE_FILE).exists());
        let incomplete = TestDirectory::new();
        drop(Storage::create_import(&incomplete.0).unwrap());
        assert!(Storage::open(&incomplete.0).is_err());
    }

    #[test]
    fn missing_orphans_do_not_block_cleanup_or_count_as_freed_bytes() {
        let root = TestDirectory::new();
        let storage = Storage::open(&root.0).unwrap();
        for key in ["image:missing", "image:keep", "image:remove"] { put(&storage, key, b"media").unwrap(); }
        for key in ["image:missing", "image:keep"] {
            let (path, _) = storage.resolve_blob("image_files", key).unwrap();
            fs::remove_file(path).unwrap();
        }
        let keep = BlobRef { namespace: "image_files".into(), key: "image:keep".into() };
        let preview = storage.cleanup_preview(vec![keep.clone()], None).unwrap();
        assert_eq!(preview.files.len(), 2);
        assert_eq!(preview.bytes, 5);
        let result = storage.cleanup_commit(vec![keep.clone()], preview.revision, None).unwrap();
        assert_eq!((result.files, result.bytes), (1, 5));
        assert_eq!(storage.blob_list(None).unwrap().iter().map(|blob| blob.key.clone()).collect::<Vec<_>>(), vec!["image:keep".to_owned()]);
        assert_eq!(storage.usage().unwrap().missing_files, vec![keep]);
    }

    #[test]
    fn cleanup_rejects_non_files_and_escaping_paths_instead_of_treating_them_as_missing() {
        let root = TestDirectory::new();
        let storage = Storage::open(&root.0).unwrap();
        put(&storage, "image:directory", b"media").unwrap();
        let (path, _) = storage.resolve_blob("image_files", "image:directory").unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(storage.cleanup_preview(Vec::new(), None).is_err());
        assert!(storage.checked_file_if_present("media/../../personal.txt").is_err());
        assert!(storage.checked_file_if_present("other/missing.png").is_err());
        assert_eq!(storage.blob_list(None).unwrap().len(), 1);
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub namespace: String,
    pub key: String,
    pub value: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum RecordMutation {
    Set { namespace: String, key: String, value: String },
    Remove { namespace: String, key: String },
    Clear { namespace: String },
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlobRef {
    pub namespace: String,
    pub key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobInfo {
    pub namespace: String,
    pub key: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
}

impl BlobInfo {
    fn reference(&self) -> BlobRef {
        BlobRef { namespace: self.namespace.clone(), key: self.key.clone() }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub token: String,
    pub revision: u64,
    pub records: Vec<Record>,
    pub blobs: Vec<BlobInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub database_bytes: u64,
    pub media_bytes: u64,
    pub preview_bytes: u64,
    pub plugin_bytes: u64,
    pub pending_deletion_bytes: u64,
    pub files: usize,
    pub missing_files: Vec<BlobRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    pub revision: u64,
    pub files: Vec<BlobInfo>,
    pub bytes: u64,
    pub pending_files: usize,
}

#[derive(Serialize)]
pub struct CleanupResult {
    pub files: usize,
    pub bytes: u64,
}

struct Inner {
    connection: Connection,
    lease: Option<String>,
    uploads: HashSet<String>,
}

pub struct Storage {
    root: PathBuf,
    inner: Arc<Mutex<Inner>>,
    _directory_lock: File,
}

// Only an application-created upload ticket can be committed. Paths supplied by
// JavaScript never reach the file writer, even when a record key contains '/'.
pub struct BlobUpload {
    pub path: PathBuf,
    namespace: String,
    key: String,
    id: String,
    lease: Option<String>,
    inner: Arc<Mutex<Inner>>,
}

impl Drop for BlobUpload {
    fn drop(&mut self) {
        let removed = match fs::remove_file(&self.path) {
            Ok(()) => true,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        };
        if let Ok(mut inner) = self.inner.lock() {
            inner.uploads.remove(&self.id);
            let final_is_managed = inner.connection.query_row(
                "SELECT final_path IS NULL OR EXISTS(SELECT 1 FROM blobs WHERE path=final_path) FROM staged_uploads WHERE id=?1",
                [&self.id], |row| row.get::<_, bool>(0),
            ).unwrap_or(false);
            if removed && final_is_managed {
                let _ = inner.connection.execute("DELETE FROM staged_uploads WHERE id=?1", [&self.id]);
            }
        }
    }
}

pub fn validate_record_namespace(namespace: &str) -> Result<()> {
    let known = matches!(namespace, "app_state" | "preferences" | "image_generation_logs"
        | "video_generation_logs" | "prompt_cache" | "image_previews");
    let plugin = namespace.strip_prefix("plugin:").is_some_and(|id| !id.is_empty());
    if (!known && !plugin) || namespace.chars().any(char::is_control) {
        return Err("不支持的记录命名空间".into());
    }
    Ok(())
}

pub fn validate_blob_namespace(namespace: &str) -> Result<()> {
    if !matches!(namespace, "image_files" | "media_files" | "image_previews" | "plugin-binary") {
        return Err("不支持的文件命名空间".into());
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() || key.contains('\0') {
        return Err("存储键不能为空或包含空字符".into());
    }
    Ok(())
}

fn db_error(error: impl std::fmt::Display) -> String { format!("本地数据库操作失败：{error}") }
fn io_error(error: impl std::fmt::Display) -> String { format!("本地文件操作失败：{error}") }

fn revision(connection: &Connection) -> Result<u64> {
    connection.query_row("SELECT value FROM metadata WHERE key = 'revision'", [], |row| row.get(0)).map_err(db_error)
}

fn increment_revision(connection: &Connection) -> Result<()> {
    connection.execute("UPDATE metadata SET value = value + 1 WHERE key = 'revision'", []).map_err(db_error)?;
    Ok(())
}

fn check_lease(inner: &Inner, lease: Option<&str>) -> Result<()> {
    match (&inner.lease, lease) {
        (None, None) => Ok(()),
        (Some(active), Some(given)) if active == given => Ok(()),
        _ => Err("数据正在备份或维护，暂时无法写入".into()),
    }
}

fn list_records(connection: &Connection, namespace: Option<&str>) -> Result<Vec<Record>> {
    let mut statement = connection.prepare("SELECT namespace, key, value FROM records WHERE (?1 IS NULL OR namespace = ?1) ORDER BY namespace, key").map_err(db_error)?;
    let result = statement.query_map([namespace], |row| Ok(Record { namespace: row.get(0)?, key: row.get(1)?, value: row.get(2)? }))
        .map_err(db_error)?.collect::<rusqlite::Result<_>>().map_err(db_error);
    result
}

fn list_blobs(connection: &Connection, namespace: Option<&str>) -> Result<Vec<BlobInfo>> {
    let mut statement = connection.prepare("SELECT namespace, key, mime, size, sha256 FROM blobs WHERE (?1 IS NULL OR namespace = ?1) ORDER BY namespace, key").map_err(db_error)?;
    let result = statement.query_map([namespace], blob_from_row).map_err(db_error)?.collect::<rusqlite::Result<_>>().map_err(db_error);
    result
}

fn blob_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BlobInfo> {
    Ok(BlobInfo { namespace: row.get(0)?, key: row.get(1)?, mime: row.get(2)?, size: row.get(3)?, sha256: row.get(4)? })
}

pub fn hash_reader(reader: &mut impl Read, mut output: Option<&mut File>) -> Result<(u64, String)> {
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let length = reader.read(&mut buffer).map_err(io_error)?;
        if length == 0 { break; }
        digest.update(&buffer[..length]);
        if let Some(file) = output.as_deref_mut() { file.write_all(&buffer[..length]).map_err(io_error)?; }
        size = size.checked_add(length as u64).ok_or("文件大小溢出")?;
    }
    Ok((size, format!("{:x}", digest.finalize())))
}

impl Storage {
    pub fn open(root: &Path) -> Result<Self> {
        Self::open_inner(root, false, false)
    }

    pub(crate) fn open_existing(root: &Path) -> Result<Self> {
        Self::open_inner(root, false, true)
    }

    pub(crate) fn create_import(root: &Path) -> Result<Self> {
        Self::open_inner(root, true, false)
    }

    fn open_inner(root: &Path, importing: bool, existing: bool) -> Result<Self> {
        if !root.exists() {
            if existing { return Err("已有数据目录无法访问，未创建替代数据库".into()); }
            fs::create_dir_all(root).map_err(io_error)?;
        }
        let root = fs::canonicalize(root).map_err(io_error)?;
        if !root.is_dir() { return Err("数据位置必须是目录".into()); }
        if root.join(IMPORT_INCOMPLETE_FILE).exists() { return Err("该目录是未完成的导入暂存数据，不能打开".into()); }
        let is_empty = fs::read_dir(&root).map_err(io_error)?.next().is_none();
        if existing && is_empty { return Err("已有数据目录为空，未创建替代数据库".into()); }
        if importing {
            if !is_empty { return Err("导入暂存目录必须为空".into()); }
            OpenOptions::new().write(true).create_new(true).open(root.join(IMPORT_INCOMPLETE_FILE)).map_err(io_error)?.sync_all().map_err(io_error)?;
        }
        if !is_empty {
            let marker: Marker = serde_json::from_reader(File::open(root.join(MARKER_FILE)).map_err(|_| "该目录不是完整的应用数据目录".to_string())?).map_err(|_| "数据目录标记损坏".to_string())?;
            if marker.format != "infinite-canvas-data" || marker.version != 1 {
                return Err("数据目录格式未知，未修改原数据".into());
            }
            if !root.join(DATABASE_FILE).is_file() { return Err("数据目录缺少数据库，未创建替代数据库".into()); }
            if fs::canonicalize(root.join(DATABASE_FILE)).map_err(io_error)?.parent() != Some(root.as_path()) {
                return Err("数据库不能指向数据目录外部".into());
            }
        }
        let directory_lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(root.join(".lock")).map_err(io_error)?;
        directory_lock.try_lock_exclusive().map_err(|_| "数据目录已被另一个应用实例使用".to_string())?;
        let flags = if is_empty { rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE } else { rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE };
        let connection = Connection::open_with_flags(root.join(DATABASE_FILE), flags).map_err(db_error)?;
        if is_empty {
            connection.execute_batch("BEGIN;
                CREATE TABLE metadata(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
                INSERT INTO metadata VALUES ('revision', 0);
                CREATE TABLE records(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key));
                CREATE TABLE blobs(namespace TEXT NOT NULL, key TEXT NOT NULL, path TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(namespace,key));
                CREATE TABLE pending_deletions(path TEXT PRIMARY KEY, size INTEGER NOT NULL);
                CREATE TABLE staged_uploads(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, final_path TEXT);
                PRAGMA user_version=1;
                COMMIT;").map_err(db_error)?;
            fs::create_dir(root.join("media")).map_err(io_error)?;
            fs::create_dir(root.join("staging")).map_err(io_error)?;
            let mut marker = OpenOptions::new().write(true).create_new(true).open(root.join(MARKER_FILE)).map_err(io_error)?;
            serde_json::to_writer(&mut marker, &Marker { format: "infinite-canvas-data".into(), version: 1 }).map_err(io_error)?;
            marker.sync_all().map_err(io_error)?;
        } else {
            let schema: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(db_error)?;
            if schema != SCHEMA_VERSION { return Err("数据库版本未知，未修改原数据".into()); }
            let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(db_error)?;
            if integrity != "ok" { return Err("数据库损坏，未覆盖原数据".into()); }
            revision(&connection)?;
            connection.prepare("SELECT namespace,key,value FROM records") .map_err(db_error)?;
            connection.prepare("SELECT namespace,key,path,mime,size,sha256 FROM blobs").map_err(db_error)?;
            connection.prepare("SELECT path,size FROM pending_deletions").map_err(db_error)?;
            connection.prepare("SELECT id,path,final_path FROM staged_uploads").map_err(db_error)?;
            for folder in ["media", "staging"] {
                let path = root.join(folder);
                if !path.is_dir() || !fs::canonicalize(&path).map_err(io_error)?.starts_with(&root) {
                    return Err("数据目录结构损坏或指向外部位置".into());
                }
            }
        }
        connection.pragma_update(None, "journal_mode", "WAL").map_err(db_error)?;
        connection.pragma_update(None, "synchronous", "FULL").map_err(db_error)?;
        Ok(Self { root, inner: Arc::new(Mutex::new(Inner { connection, lease: None, uploads: HashSet::new() })), _directory_lock: directory_lock })
    }

    pub fn root(&self) -> &Path { &self.root }

    fn lock(&self) -> Result<MutexGuard<'_, Inner>> {
        self.inner.lock().map_err(|_| "本地存储状态不可用".into())
    }

    pub fn revision(&self) -> Result<u64> { revision(&self.lock()?.connection) }

    pub fn records_get(&self, namespace: &str, key: &str) -> Result<Option<String>> {
        validate_record_namespace(namespace)?;
        validate_key(key)?;
        self.lock()?.connection.query_row("SELECT value FROM records WHERE namespace=?1 AND key=?2", params![namespace,key], |row| row.get(0)).optional().map_err(db_error)
    }

    pub fn records_list(&self, namespace: Option<&str>) -> Result<Vec<Record>> {
        if let Some(value) = namespace { validate_record_namespace(value)?; }
        list_records(&self.lock()?.connection, namespace)
    }

    pub fn records_batch(&self, mutations: Vec<RecordMutation>, expected_revision: Option<u64>, lease: Option<&str>) -> Result<u64> {
        let mut inner = self.lock()?;
        check_lease(&inner, lease)?;
        if expected_revision.is_some_and(|expected| revision(&inner.connection).ok() != Some(expected)) {
            return Err("数据已变化，请重新读取后重试".into());
        }
        if mutations.is_empty() { return revision(&inner.connection); }
        let transaction = inner.connection.transaction().map_err(db_error)?;
        let mut changed = 0;
        for mutation in mutations {
            match mutation {
                RecordMutation::Set { namespace, key, value } => {
                    validate_record_namespace(&namespace)?;
                    validate_key(&key)?;
                    changed += transaction.execute("INSERT INTO records(namespace,key,value) VALUES (?1,?2,?3) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value WHERE value != excluded.value", params![namespace,key,value]).map_err(db_error)?;
                }
                RecordMutation::Remove { namespace, key } => {
                    validate_record_namespace(&namespace)?;
                    validate_key(&key)?;
                    changed += transaction.execute("DELETE FROM records WHERE namespace=?1 AND key=?2", params![namespace,key]).map_err(db_error)?;
                }
                RecordMutation::Clear { namespace } => {
                    validate_record_namespace(&namespace)?;
                    changed += transaction.execute("DELETE FROM records WHERE namespace=?1", [namespace]).map_err(db_error)?;
                }
            }
        }
        if changed > 0 { increment_revision(&transaction)?; }
        transaction.commit().map_err(db_error)?;
        revision(&inner.connection)
    }

    pub fn flush(&self) -> Result<()> {
        let inner = self.lock()?;
        if !inner.uploads.is_empty() { return Err("媒体文件尚未保存完成".into()); }
        inner.connection.execute_batch("PRAGMA wal_checkpoint(FULL);").map_err(db_error)
    }

    pub fn begin_maintenance(&self) -> Result<Snapshot> {
        let mut inner = self.lock()?;
        if inner.lease.is_some() || !inner.uploads.is_empty() { return Err("存储正在写入或维护，请稍后重试".into()); }
        let snapshot = Snapshot { token: Uuid::new_v4().to_string(), revision: revision(&inner.connection)?, records: list_records(&inner.connection, None)?, blobs: list_blobs(&inner.connection, None)? };
        inner.lease = Some(snapshot.token.clone());
        Ok(snapshot)
    }

    pub fn maintenance_snapshot(&self, token: &str) -> Result<Snapshot> {
        let inner = self.lock()?;
        check_lease(&inner, Some(token))?;
        if !inner.uploads.is_empty() { return Err("维护写入尚未完成".into()); }
        Ok(Snapshot { token: token.into(), revision: revision(&inner.connection)?, records: list_records(&inner.connection, None)?, blobs: list_blobs(&inner.connection, None)? })
    }

    pub fn end_maintenance(&self, token: &str) -> Result<()> {
        let mut inner = self.lock()?;
        if inner.lease.as_deref() != Some(token) { return Err("维护会话无效".into()); }
        if !inner.uploads.is_empty() { return Err("维护写入尚未完成".into()); }
        inner.lease = None;
        Ok(())
    }

    pub fn blob_list(&self, namespace: Option<&str>) -> Result<Vec<BlobInfo>> {
        if let Some(value) = namespace { validate_blob_namespace(value)?; }
        list_blobs(&self.lock()?.connection, namespace)
    }

    pub fn create_blob_temp(&self, namespace: &str, key: &str, lease: Option<&str>) -> Result<BlobUpload> {
        validate_blob_namespace(namespace)?;
        validate_key(key)?;
        let mut inner = self.lock()?;
        check_lease(&inner, lease)?;
        let id = Uuid::new_v4().to_string();
        let path = self.checked_directory("staging")?.join(format!("{id}.part"));
        OpenOptions::new().write(true).create_new(true).open(&path).map_err(io_error)?;
        if let Err(error) = inner.connection.execute("INSERT INTO staged_uploads(id,path) VALUES(?1,?2)", params![id,format!("staging/{id}.part")]) {
            let _ = fs::remove_file(&path);
            return Err(db_error(error));
        }
        inner.uploads.insert(id.clone());
        Ok(BlobUpload { path, namespace: namespace.into(), key: key.into(), id, lease: lease.map(str::to_owned), inner: self.inner.clone() })
    }

    pub fn commit_blob(&self, upload: BlobUpload, mime: &str) -> Result<BlobInfo> {
        let mut source = OpenOptions::new().read(true).write(true).open(&upload.path).map_err(io_error)?;
        let (size, sha256) = hash_reader(&mut source, None)?;
        source.sync_all().map_err(io_error)?;
        drop(source);
        let mut inner = self.lock()?;
        check_lease(&inner, upload.lease.as_deref())?;
        if !Arc::ptr_eq(&self.inner, &upload.inner) || !inner.uploads.contains(&upload.id) { return Err("媒体上传会话无效".into()); }
        let existing = inner.connection.query_row("SELECT namespace,key,mime,size,sha256 FROM blobs WHERE namespace=?1 AND key=?2", params![upload.namespace,upload.key], blob_from_row).optional().map_err(db_error)?;
        if let Some(existing) = existing {
            if existing.sha256 != sha256 || existing.size != size { return Err(BLOB_CONFLICT.into()); }
            let path: String = inner.connection.query_row("SELECT path FROM blobs WHERE namespace=?1 AND key=?2", params![upload.namespace,upload.key], |row| row.get(0)).map_err(db_error)?;
            let mut existing_file = File::open(self.checked_file(&path)?).map_err(io_error)?;
            let (actual_size, actual_hash) = hash_reader(&mut existing_file, None)?;
            if actual_size != existing.size || actual_hash != existing.sha256 { return Err(BLOB_MODIFIED.into()); }
            return Ok(existing);
        }
        let extension = mime_guess::get_mime_extensions_str(mime).and_then(|values| values.first()).copied().unwrap_or("bin");
        let relative = format!("media/{}.{}", Uuid::new_v4(), extension);
        self.checked_directory("media")?;
        let destination = self.root.join(&relative);
        // The destination is durable before rename, so a crash between rename
        // and index commit cannot turn an application file into unknown garbage.
        inner.connection.execute("UPDATE staged_uploads SET final_path=?1 WHERE id=?2", params![relative,upload.id]).map_err(db_error)?;
        fs::rename(&upload.path, &destination).map_err(io_error)?;
        let info = BlobInfo { namespace: upload.namespace.clone(), key: upload.key.clone(), mime: mime.into(), size, sha256 };
        let transaction = inner.connection.transaction().map_err(db_error)?;
        let write = transaction.execute("INSERT INTO blobs(namespace,key,path,mime,size,sha256) VALUES (?1,?2,?3,?4,?5,?6)", params![info.namespace,info.key,relative,info.mime,info.size,info.sha256]).map_err(db_error)
            .and_then(|_| increment_revision(&transaction));
        if let Err(error) = write { let _ = fs::remove_file(&destination); return Err(error); }
        if let Err(error) = transaction.commit() { let _ = fs::remove_file(&destination); return Err(db_error(error)); }
        Ok(info)
    }

    fn checked_file(&self, relative: &str) -> Result<PathBuf> {
        self.checked_file_if_present(relative)?.ok_or_else(|| "本地媒体文件缺失".into())
    }

    fn checked_file_if_present(&self, relative: &str) -> Result<Option<PathBuf>> {
        let path = Path::new(relative);
        if path.is_absolute() || path.components().any(|component| !matches!(component, std::path::Component::Normal(_))) || !relative.starts_with("media/") {
            return Err("媒体索引路径无效".into());
        }
        self.checked_directory("media")?;
        let expected = self.root.join(path);
        let parent = expected.parent().ok_or("媒体索引路径无效")?;
        let actual_parent = fs::canonicalize(parent).map_err(io_error)?;
        if actual_parent.as_path() != parent || !actual_parent.starts_with(self.root.join("media")) {
            return Err("媒体目录被移动或指向其他位置".into());
        }
        let metadata = match fs::symlink_metadata(&expected) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        if !metadata.file_type().is_file() { return Err("媒体路径不是普通文件".into()); }
        let absolute = fs::canonicalize(&expected).map_err(io_error)?;
        if absolute != expected { return Err("媒体文件被移动或指向其他位置".into()); }
        Ok(Some(absolute))
    }

    fn checked_directory(&self, name: &str) -> Result<PathBuf> {
        let expected = self.root.join(name);
        let actual = fs::canonicalize(&expected).map_err(io_error)?;
        if actual != expected || !actual.is_dir() { return Err("应用数据子目录被移动或指向外部位置".into()); }
        Ok(actual)
    }

    fn abandoned_uploads(&self, inner: &Inner) -> Result<Vec<(String, PathBuf, u64)>> {
        let mut statement = inner.connection.prepare("SELECT id,path,final_path FROM staged_uploads").map_err(db_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))).map_err(db_error)?;
        let mut abandoned = Vec::new();
        for row in rows {
            let (id, relative, final_path) = row.map_err(db_error)?;
            if inner.uploads.contains(&id) { continue; }
            if Uuid::parse_str(&id).is_err() || relative != format!("staging/{id}.part") { return Err("暂存文件索引无效".into()); }
            let mut path = self.checked_directory("staging")?.join(format!("{id}.part"));
            if let Some(final_path) = final_path {
                let indexed: bool = inner.connection.query_row("SELECT EXISTS(SELECT 1 FROM blobs WHERE path=?1)", [&final_path], |row| row.get(0)).map_err(db_error)?;
                if !indexed && self.root.join(&final_path).exists() {
                    path = self.checked_file(&final_path)?;
                }
            }
            let size = match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_file() => metadata.len(),
                Ok(_) => return Err("暂存文件被移动或修改".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
                Err(error) => return Err(io_error(error)),
            };
            abandoned.push((id, path, size));
        }
        Ok(abandoned)
    }

    pub fn resolve_blob(&self, namespace: &str, key: &str) -> Result<(PathBuf, BlobInfo)> {
        validate_blob_namespace(namespace)?;
        validate_key(key)?;
        let inner = self.lock()?;
        let info = inner.connection.query_row("SELECT namespace,key,mime,size,sha256 FROM blobs WHERE namespace=?1 AND key=?2", params![namespace,key], blob_from_row).optional().map_err(db_error)?.ok_or("本地媒体不存在")?;
        let path: String = inner.connection.query_row("SELECT path FROM blobs WHERE namespace=?1 AND key=?2", params![namespace,key], |row| row.get(0)).map_err(db_error)?;
        let file = self.checked_file(&path)?;
        if fs::metadata(&file).map_err(io_error)?.len() != info.size { return Err("本地媒体文件已被外部修改".into()); }
        Ok((file, info))
    }

    pub fn usage(&self) -> Result<StorageUsage> {
        let blobs = self.blob_list(None)?;
        let pending_deletion_bytes = {
            let inner = self.lock()?;
            let bytes: u64 = inner.connection.query_row("SELECT COALESCE(SUM(size),0) FROM pending_deletions", [], |row| row.get(0)).map_err(db_error)?;
            bytes + self.abandoned_uploads(&inner)?.iter().map(|(_,_,size)| size).sum::<u64>()
        };
        let mut usage = StorageUsage { database_bytes: 0, media_bytes: 0, preview_bytes: 0, plugin_bytes: 0, pending_deletion_bytes, files: blobs.len(), missing_files: Vec::new() };
        for name in [DATABASE_FILE.to_string(), format!("{DATABASE_FILE}-wal"), format!("{DATABASE_FILE}-shm")] {
            usage.database_bytes += fs::metadata(self.root.join(name)).map(|metadata| metadata.len()).unwrap_or(0);
        }
        for blob in blobs {
            match blob.namespace.as_str() {
                "image_previews" => usage.preview_bytes += blob.size,
                "plugin-binary" => usage.plugin_bytes += blob.size,
                _ => usage.media_bytes += blob.size,
            }
            if self.resolve_blob(&blob.namespace, &blob.key).is_err() { usage.missing_files.push(blob.reference()); }
        }
        Ok(usage)
    }

    pub fn cleanup_preview(&self, references: Vec<BlobRef>, lease: Option<&str>) -> Result<CleanupPreview> {
        let inner = self.lock()?;
        check_lease(&inner, lease)?;
        if !inner.uploads.is_empty() { return Err("存储正在写入，无法清理".into()); }
        let references: HashSet<_> = references.into_iter().collect();
        let mut files: Vec<_> = list_blobs(&inner.connection, None)?.into_iter().filter(|blob| !references.contains(&blob.reference())).collect();
        for blob in &mut files {
            let path: String = inner.connection.query_row("SELECT path FROM blobs WHERE namespace=?1 AND key=?2", params![blob.namespace,blob.key], |row| row.get(0)).map_err(db_error)?;
            blob.size = match self.checked_file_if_present(&path)? {
                Some(path) => fs::metadata(path).map_err(io_error)?.len(),
                None => 0,
            };
        }
        let (pending_files, pending_bytes): (usize, u64) = inner.connection.query_row("SELECT COUNT(*),COALESCE(SUM(size),0) FROM pending_deletions", [], |row| Ok((row.get(0)?,row.get(1)?))).map_err(db_error)?;
        let abandoned = self.abandoned_uploads(&inner)?;
        Ok(CleanupPreview { revision: revision(&inner.connection)?, bytes: files.iter().map(|blob| blob.size).sum::<u64>() + pending_bytes + abandoned.iter().map(|(_,_,size)| size).sum::<u64>(), files, pending_files: pending_files + abandoned.len() })
    }

    pub fn cleanup_commit(&self, references: Vec<BlobRef>, expected_revision: u64, lease: Option<&str>) -> Result<CleanupResult> {
        let mut inner = self.lock()?;
        check_lease(&inner, lease)?;
        if !inner.uploads.is_empty() { return Err("存储正在写入，无法清理".into()); }
        if revision(&inner.connection)? != expected_revision { return Err("扫描后数据已变化，请重新扫描".into()); }
        let references: HashSet<_> = references.into_iter().collect();
        let candidates: Vec<_> = list_blobs(&inner.connection, None)?.into_iter().filter(|blob| !references.contains(&blob.reference())).collect();
        // Persist the deletion intent before removing files. A crash can leave
        // only managed garbage, never an indexed file missing after rollback.
        let transaction = inner.connection.transaction().map_err(db_error)?;
        let preview_keys = {
            let mut statement = transaction.prepare("SELECT key FROM records WHERE namespace='image_previews' AND substr(key,1,6)='image:'").map_err(db_error)?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(db_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)?
        };
        let mut removed_preview_records = 0;
        for key in preview_keys {
            if !references.contains(&BlobRef { namespace: "image_files".into(), key: key.clone() }) {
                removed_preview_records += transaction.execute("DELETE FROM records WHERE namespace='image_previews' AND key=?1", [key]).map_err(db_error)?;
            }
        }
        for blob in &candidates {
            let relative: String = transaction.query_row("SELECT path FROM blobs WHERE namespace=?1 AND key=?2", params![blob.namespace,blob.key], |row| row.get(0)).map_err(db_error)?;
            if let Some(path) = self.checked_file_if_present(&relative)? {
                let bytes = fs::metadata(path).map_err(io_error)?.len();
                transaction.execute("INSERT INTO pending_deletions(path,size) VALUES(?1,?2)", params![relative,bytes]).map_err(db_error)?;
            }
            transaction.execute("DELETE FROM blobs WHERE namespace=?1 AND key=?2", params![blob.namespace,blob.key]).map_err(db_error)?;
        }
        if !candidates.is_empty() || removed_preview_records > 0 { increment_revision(&transaction)?; }
        transaction.commit().map_err(db_error)?;
        let pending = {
            let mut statement = inner.connection.prepare("SELECT path,size FROM pending_deletions").map_err(db_error)?;
            let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))).map_err(db_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)?
        };
        let mut result = CleanupResult { files: 0, bytes: 0 };
        for (relative, _size) in pending {
            if let Some(path) = self.checked_file_if_present(&relative)? {
                let bytes = fs::metadata(&path).map_err(io_error)?.len();
                fs::remove_file(path).map_err(io_error)?;
                result.files += 1;
                result.bytes += bytes;
            }
            inner.connection.execute("DELETE FROM pending_deletions WHERE path=?1", [relative]).map_err(db_error)?;
        }
        for (id, path, size) in self.abandoned_uploads(&inner)? {
            if path.exists() {
                fs::remove_file(path).map_err(io_error)?;
                result.files += 1;
                result.bytes += size;
            }
            inner.connection.execute("DELETE FROM staged_uploads WHERE id=?1", [id]).map_err(db_error)?;
        }
        Ok(result)
    }
}
