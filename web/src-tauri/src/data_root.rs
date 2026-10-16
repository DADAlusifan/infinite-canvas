use crate::{backup, bootstrap, storage::{hash_reader, RecordMutation, Snapshot, Storage, IMPORT_INCOMPLETE_FILE, MARKER_FILE}};
use std::{fs::{self, File, OpenOptions}, io::{self, Read}, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

fn check_cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) { return Err("已取消更改数据目录，原数据未修改".into()); }
    Ok(())
}

struct CancellableFile<'a> { file: File, cancel: &'a AtomicBool }
impl Read for CancellableFile<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        check_cancelled(self.cancel).map_err(io::Error::other)?;
        self.file.read(buffer)
    }
}

pub fn independent_target(current: &Path, target: &Path) -> Result<PathBuf> {
    let current = fs::canonicalize(current).map_err(|error| error.to_string())?;
    let target = fs::canonicalize(target).map_err(|error| error.to_string())?;
    if !target.is_dir() { return Err("数据位置必须是目录".into()); }
    if target.starts_with(&current) || current.starts_with(&target) {
        return Err("新数据目录不能是当前目录、当前目录的父目录或子目录".into());
    }
    Ok(target)
}

pub fn verify_media(storage: &Storage, cancel: &AtomicBool) -> Result<()> {
    check_cancelled(cancel)?;
    let blobs = storage.blob_list(None)?;
    backup::validate_records(&storage.records_list(None)?, &blobs)?;
    for blob in blobs {
        check_cancelled(cancel)?;
        let (path, _) = storage.resolve_blob(&blob.namespace, &blob.key)?;
        let file = File::open(path).map_err(|error| error.to_string())?;
        let (size, hash) = hash_reader(&mut CancellableFile { file, cancel }, None)?;
        if size != blob.size || hash != blob.sha256 {
            return Err(format!("媒体文件校验失败：{}/{}；未切换数据目录", blob.namespace, blob.key));
        }
    }
    check_cancelled(cancel)
}

pub fn copy_current(source: &Storage, snapshot: Snapshot, target: &Path, cancel: &AtomicBool) -> Result<()> {
    check_cancelled(cancel)?;
    let target = independent_target(source.root(), target)?;
    if fs::read_dir(&target).map_err(|error| error.to_string())?.next().is_some() {
        return Err("复制当前数据需要新的空目录，不会合并或覆盖已有文件".into());
    }
    if source.maintenance_snapshot(&snapshot.token)?.revision != snapshot.revision {
        return Err("源数据已变化，请重新选择数据目录".into());
    }
    backup::validate_records(&snapshot.records, &snapshot.blobs)?;
    let required = snapshot.blobs.iter().try_fold(0u64, |sum, blob| sum.checked_add(blob.size))
        .and_then(|sum| snapshot.records.iter().try_fold(sum, |sum, record| sum.checked_add(record.value.len() as u64)))
        .ok_or("数据大小溢出")?;
    if fs2::available_space(&target).map_err(|error| error.to_string())? < required {
        return Err("目标磁盘剩余空间不足，原数据未修改".into());
    }
    let staging = target.join(format!(".copy-{}", Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let destination = Storage::create_import(&staging)?;
    for blob in &snapshot.blobs {
        check_cancelled(cancel)?;
        let (path, _) = source.resolve_blob(&blob.namespace, &blob.key)?;
        let file = File::open(path).map_err(|error| error.to_string())?;
        let upload = destination.create_blob_temp(&blob.namespace, &blob.key, None)?;
        let mut output = OpenOptions::new().write(true).truncate(true).open(&upload.path).map_err(|error| error.to_string())?;
        let (size, hash) = hash_reader(&mut CancellableFile { file, cancel }, Some(&mut output))?;
        if size != blob.size || hash != blob.sha256 {
            return Err(format!("源媒体文件缺失或已变化：{}/{}；原数据未修改", blob.namespace, blob.key));
        }
        output.sync_all().map_err(|error| error.to_string())?;
        drop(output);
        let copied = destination.commit_blob(upload, &blob.mime)?;
        if copied.size != blob.size || copied.sha256 != blob.sha256 { return Err("目标媒体写入校验失败，原数据未修改".into()); }
    }
    if source.maintenance_snapshot(&snapshot.token)?.revision != snapshot.revision {
        return Err("复制期间源数据已变化，原数据未修改".into());
    }
    check_cancelled(cancel)?;
    destination.records_batch(snapshot.records.into_iter().map(|record| RecordMutation::Set {
        namespace: record.namespace, key: record.key, value: record.value,
    }).collect(), None, None)?;
    finish_import(destination, &target, cancel)?;
    let destination = bootstrap::open_storage(&target)?;
    destination.flush()
}

// Both archive import and direct copy publish the valid root marker last.
// Interrupted work remains in a new, incomplete directory; the source is untouched.
pub(crate) fn finish_import(storage: Storage, target: &Path, cancel: &AtomicBool) -> Result<()> {
    check_cancelled(cancel)?;
    bootstrap::write_environment_marker(storage.root())?;
    storage.flush()?;
    let staging = storage.root().to_path_buf();
    drop(storage);
    check_cancelled(cancel)?;
    let children: Vec<PathBuf> = fs::read_dir(&staging).map_err(|error| error.to_string())?
        .map(|entry| entry.map(|entry| entry.path())).collect::<io::Result<_>>().map_err(|error| error.to_string())?;
    for entry in fs::read_dir(target).map_err(|error| error.to_string())? {
        if entry.map_err(|error| error.to_string())?.path() != staging { return Err("操作期间目标目录出现其他文件，未完成切换".into()); }
    }
    for child in children.iter().filter(|child| child.file_name().is_some_and(|name| name != MARKER_FILE && name != IMPORT_INCOMPLETE_FILE)) {
        check_cancelled(cancel)?;
        let destination = target.join(child.file_name().ok_or("无效的暂存文件名")?);
        match fs::symlink_metadata(&destination) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
            Ok(_) => return Err("操作期间目标目录发生变化，未完成切换".into()),
        }
        fs::rename(child, destination).map_err(|error| format!("完成数据目录操作失败，原数据未修改：{error}"))?;
    }
    check_cancelled(cancel)?;
    if fs::symlink_metadata(target.join(MARKER_FILE)).is_ok() { return Err("操作期间目标目录标记发生变化，未完成切换".into()); }
    fs::remove_file(staging.join(IMPORT_INCOMPLETE_FILE)).map_err(|error| error.to_string())?;
    fs::rename(staging.join(MARKER_FILE), target.join(MARKER_FILE)).map_err(|error| error.to_string())?;
    // Publication is complete. An empty staging folder that cannot be removed
    // must not turn a successful data copy into a failed operation.
    let _ = fs::remove_dir(staging);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("infinite-canvas-directory-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn child(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir(&path).unwrap();
            path
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }
    fn put(storage: &Storage, key: &str, bytes: &[u8]) {
        let upload = storage.create_blob_temp("image_files", key, None).unwrap();
        fs::write(&upload.path, bytes).unwrap();
        storage.commit_blob(upload, "image/png").unwrap();
    }
    fn encoded(value: Value) -> String {
        json!({"format":"infinite-canvas-value","version":1,"data":{"json":{
            "value":value,"binaries":[],"arrays":[],"nullObjects":[],"regexps":[],"collections":[]
        }}}).to_string()
    }

    #[test]
    fn copy_preserves_records_and_unreferenced_media_without_webview_cache() {
        let root = TestDirectory::new();
        let source = bootstrap::open_storage(&root.child("source")).unwrap();
        let target = root.child("target");
        let value = encoded(json!({"content":"unchanged"}));
        source.records_batch(vec![RecordMutation::Set { namespace: "plugin:example".into(), key: "state".into(), value: value.clone() }], None, None).unwrap();
        put(&source, "image:unreferenced", b"original");
        fs::create_dir(source.root().join("cache")).unwrap();
        fs::write(source.root().join("cache/browser"), b"cache").unwrap();
        let snapshot = source.begin_maintenance().unwrap();
        let lease = snapshot.token.clone();
        assert!(source.maintenance_snapshot("wrong-lease").is_err());
        copy_current(&source, snapshot, &target, &AtomicBool::new(false)).unwrap();
        let copied = bootstrap::open_existing_storage(&target).unwrap();
        assert_eq!(copied.records_get("plugin:example", "state").unwrap(), Some(value));
        let (path, _) = copied.resolve_blob("image_files", "image:unreferenced").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"original");
        assert!(!target.join("cache").exists());
        assert!(source.resolve_blob("image_files", "image:unreferenced").is_ok());
        assert!(source.records_batch(vec![], None, None).is_err());
        source.end_maintenance(&lease).unwrap();
    }

    #[test]
    fn copy_rejects_related_nonempty_changed_and_cancelled_destinations() {
        let root = TestDirectory::new();
        let source = bootstrap::open_storage(&root.child("source")).unwrap();
        let child = source.root().join("child");
        fs::create_dir(&child).unwrap();
        assert!(independent_target(source.root(), source.root()).is_err());
        assert!(independent_target(source.root(), &root.0).is_err());
        assert!(independent_target(source.root(), &child).is_err());
        put(&source, "image:one", b"original");
        let snapshot = source.begin_maintenance().unwrap();
        let lease = snapshot.token.clone();
        let nonempty = root.child("nonempty");
        fs::write(nonempty.join("personal.txt"), b"preserve").unwrap();
        assert!(copy_current(&source, snapshot, &nonempty, &AtomicBool::new(false)).is_err());
        let snapshot = source.maintenance_snapshot(&lease).unwrap();
        let cancelled = root.child("cancelled");
        assert!(copy_current(&source, snapshot, &cancelled, &AtomicBool::new(true)).is_err());
        assert!(fs::read_dir(cancelled).unwrap().next().is_none());
        let changed = root.child("changed");
        let (path, _) = source.resolve_blob("image_files", "image:one").unwrap();
        fs::write(path, b"modified").unwrap();
        let snapshot = source.maintenance_snapshot(&lease).unwrap();
        assert!(copy_current(&source, snapshot, &changed, &AtomicBool::new(false)).is_err());
        assert!(!changed.join(MARKER_FILE).exists());
        assert!(source.root().join(MARKER_FILE).is_file());
    }

    #[test]
    fn existing_directory_requires_environment_lock_and_intact_media() {
        let root = TestDirectory::new();
        let empty = root.child("empty");
        assert!(bootstrap::open_existing_storage(&empty).is_err());
        assert!(fs::read_dir(&empty).unwrap().next().is_none());
        let target = root.child("existing");
        let storage = bootstrap::open_storage(&target).unwrap();
        put(&storage, "image:one", b"original");
        assert!(bootstrap::open_existing_storage(&target).is_err());
        let (path, _) = storage.resolve_blob("image_files", "image:one").unwrap();
        drop(storage);
        let storage = bootstrap::open_existing_storage(&target).unwrap();
        verify_media(&storage, &AtomicBool::new(false)).unwrap();
        storage.records_batch(vec![RecordMutation::Set { namespace: "app_state".into(), key: "canvas".into(), value: encoded(json!({"storageKey":"image:not-indexed"})) }], None, None).unwrap();
        assert!(verify_media(&storage, &AtomicBool::new(false)).is_err());
        storage.records_batch(vec![RecordMutation::Remove { namespace: "app_state".into(), key: "canvas".into() }], None, None).unwrap();
        fs::remove_file(path).unwrap();
        assert!(verify_media(&storage, &AtomicBool::new(false)).is_err());
        drop(storage);
        fs::write(target.join("desktop-environment.json"), serde_json::to_vec(if cfg!(debug_assertions) { "production" } else { "development" }).unwrap()).unwrap();
        assert!(bootstrap::open_existing_storage(&target).is_err());
    }
}
