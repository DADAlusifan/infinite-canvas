use crate::storage::{hash_reader, validate_blob_namespace, validate_record_namespace, BlobInfo, BlobRef, Record, RecordMutation, Storage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;
use zip::ZipArchive;

type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    records: Vec<RecordEntry>,
    blobs: Vec<BlobEntry>,
    counts: Counts,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Counts { records: u64, binaries: u64, bytes: u64 }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordEntry {
    namespace: String,
    key: String,
    kind: String,
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BlobEntry {
    namespace: String,
    key: String,
    path: String,
    mime: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize)]
pub struct ImportResult { pub records: usize, pub blobs: usize, pub bytes: u64 }

fn canceled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) { return Err("已取消导入，原数据未修改".into()); }
    Ok(())
}

fn check_digest(size: u64, hash: &str, expected_size: u64, expected_hash: &str) -> Result<()> {
    if size != expected_size || hash != expected_hash { return Err("备份文件大小或 SHA-256 校验不符".into()); }
    Ok(())
}

fn hash_cancellable(reader: &mut impl Read, mut output: Option<&mut File>, cancel: &AtomicBool) -> Result<(u64, String)> {
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut bytes = [0u8; 64 * 1024];
    loop {
        canceled(cancel)?;
        let length = reader.read(&mut bytes).map_err(|error| format!("备份文件读取失败：{error}"))?;
        if length == 0 { break; }
        digest.update(&bytes[..length]);
        if let Some(file) = output.as_deref_mut() {
            file.write_all(&bytes[..length]).map_err(|error| format!("导入文件写入失败：{error}"))?;
        }
        size = size.checked_add(length as u64).ok_or("备份文件大小溢出")?;
    }
    Ok((size, format!("{:x}", digest.finalize())))
}

fn valid_entry_path(path: &str, directory: &str, suffix: &str) -> bool {
    path.strip_prefix(directory).and_then(|value| value.strip_suffix(suffix))
        .is_some_and(|index| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_entry(key: &str, path: &str, hash: &str, paths: &mut HashSet<String>) -> Result<()> {
    if key.is_empty() || key.contains('\0') { return Err("备份包含无效存储键".into()); }
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("备份包含无效 SHA-256".into());
    }
    if !paths.insert(path.into()) { return Err("备份包含重复的文件路径".into()); }
    Ok(())
}

fn text_field(key: &str) -> bool {
    matches!(key, "content" | "text" | "prompt" | "systemPrompt" | "title" | "description" | "note" | "script" | "url" | "dataUrl" | "coverUrl" | "previewUrl" | "thumbnailUrl")
}

fn add_media_key(key: &str, references: &mut HashSet<BlobRef>) {
    references.insert(BlobRef { namespace: if key.starts_with("image:") { "image_files" } else { "media_files" }.into(), key: key.into() });
}

fn reference_key(key: &str) -> bool {
    ["image:", "video:", "audio:", "file:", "video-reference:", "audio-reference:"].iter().any(|prefix|
        key.strip_prefix(*prefix).is_some_and(|suffix| !suffix.is_empty() && !suffix.chars().any(|c| c.is_whitespace() || c == '/' || c == '\\')))
}

fn gather_plain_references(value: &Value, reference_list: bool, references: &mut HashSet<BlobRef>) {
    match value {
        Value::String(key) => {
            if reference_list {
                if reference_key(key) { add_media_key(key, references); }
            } else if key.trim_start().starts_with('{') || key.trim_start().starts_with('[') {
                if let Ok(parsed) = serde_json::from_str::<Value>(key) { gather_plain_references(&parsed, false, references); }
            }
        }
        Value::Array(values) => values.iter().for_each(|value| gather_plain_references(value, reference_list, references)),
        Value::Object(object) => for (key, value) in object {
            if key == "storageKey" && value.is_string() {
                if let Some(value) = value.as_str().filter(|value| value.contains(':')) { add_media_key(value, references); }
            } else if !(text_field(key) && value.is_string()) { gather_plain_references(value, key == "references", references); }
        },
        _ => {}
    }
}

// Index the serialized graph by SuperJSON's escaped paths, so shared arrays and
// Map/Set references inherit the meaning of the field that contains them.
struct MediaReferenceReader<'a> {
    nodes: HashMap<String, &'a Value>,
    aliases: HashMap<String, String>,
    collections: HashMap<String, usize>,
    typed: HashSet<String>,
}

fn child_path(parent: &str, key: &str) -> String {
    let key = key.replace('\\', "\\\\").replace('.', "\\.");
    if parent.is_empty() { key } else { format!("{parent}.{key}") }
}

fn index_values<'a>(value: &'a Value, path: String, nodes: &mut HashMap<String, &'a Value>) {
    nodes.insert(path.clone(), value);
    match value {
        Value::Object(object) => for (key, value) in object { index_values(value, child_path(&path, key), nodes); },
        Value::Array(values) => for (index, value) in values.iter().enumerate() { index_values(value, child_path(&path, &index.to_string()), nodes); },
        _ => {}
    }
}

impl<'a> MediaReferenceReader<'a> {
    fn new(data: &'a Value, meta: Option<&Value>) -> Self {
        let mut reader = Self { nodes: HashMap::new(), aliases: HashMap::new(), collections: HashMap::new(), typed: HashSet::new() };
        index_values(data, String::new(), &mut reader.nodes);
        if let Some(equalities) = meta.and_then(|meta| meta.get("referentialEqualities")).and_then(Value::as_object) {
            for (original, aliases) in equalities {
                if let Some(aliases) = aliases.as_array() { for alias in aliases.iter().filter_map(Value::as_str) { reader.aliases.insert(alias.into(), original.clone()); } }
            }
        }
        if let Some(values) = meta.and_then(|meta| meta.get("values")).and_then(Value::as_object) { reader.typed.extend(values.keys().cloned()); }
        if let Some(collections) = data.get("collections").and_then(Value::as_array) {
            for index in 0..collections.len() {
                let path = format!("collections.{index}.node");
                reader.collections.insert(reader.aliases.get(&path).cloned().unwrap_or(path), index);
            }
        }
        reader
    }

    fn property(&self, name: &str, path: &str, seen: &mut HashSet<(String, bool)>, references: &mut HashSet<BlobRef>) {
        let canonical = self.aliases.get(path).map(String::as_str).unwrap_or(path);
        if self.typed.contains(canonical) { return; }
        let Some(value) = self.nodes.get(canonical) else { return; };
        if name == "storageKey" && value.is_string() {
            if let Some(key) = value.as_str().filter(|key| key.contains(':')) { add_media_key(key, references); }
        } else if !(text_field(name) && value.is_string()) { self.walk(path, name == "references", seen, references); }
    }

    fn walk(&self, path: &str, reference_list: bool, seen: &mut HashSet<(String, bool)>, references: &mut HashSet<BlobRef>) {
        let canonical = self.aliases.get(path).map(String::as_str).unwrap_or(path);
        if self.typed.contains(canonical) || !seen.insert((canonical.into(), reference_list)) { return; }
        if let Some(index) = self.collections.get(canonical) {
            let base = format!("collections.{index}");
            let Some(entries) = self.nodes.get(&format!("{base}.entries")).and_then(|value| value.as_array()) else { return; };
            let is_map = self.nodes.get(&format!("{base}.kind")).and_then(|value| value.as_str()) == Some("Map");
            for (index, entry) in entries.iter().enumerate() {
                let path = format!("{base}.entries.{index}");
                if is_map {
                    self.walk(&format!("{path}.0"), false, seen, references);
                    let name = entry.get(0).and_then(Value::as_str).unwrap_or("");
                    self.property(name, &format!("{path}.1"), seen, references);
                } else { self.walk(&path, reference_list, seen, references); }
            }
            return;
        }
        match self.nodes.get(canonical).copied() {
            Some(Value::Object(object)) => for key in object.keys() { self.property(key, &child_path(canonical, key), seen, references); },
            Some(Value::Array(values)) => for index in 0..values.len() { self.walk(&child_path(canonical, &index.to_string()), reference_list, seen, references); },
            Some(value) => gather_plain_references(value, reference_list, references),
            None => {}
        }
    }
}

fn validate_record(value: &str, namespace: &str, kind: &str, blobs: &HashMap<BlobRef, u64>) -> Result<()> {
    if namespace == "preferences" {
        if kind != "preference" { return Err("偏好记录的类型无效".into()); }
        return Ok(());
    }
    if kind != "value" { return Err("业务记录的类型无效".into()); }
    let envelope: Value = serde_json::from_str(value).map_err(|_| "备份业务记录不是有效 JSON".to_string())?;
    if envelope.get("format").and_then(Value::as_str) != Some("infinite-canvas-value") || envelope.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("备份业务记录的编码版本未知".into());
    }
    let data = envelope.pointer("/data/json").ok_or("备份业务记录缺少数据")?;
    let descriptors = data.get("binaries").and_then(Value::as_array).ok_or("备份业务记录缺少二进制描述")?;
    for name in ["arrays", "nullObjects", "regexps", "collections"] {
        if !data.get(name).is_some_and(Value::is_array) { return Err("备份业务记录的数据结构损坏".into()); }
    }
    let namespace = if namespace == "image_previews" { "image_previews" } else { "plugin-binary" };
    for descriptor in descriptors {
        let kind = descriptor.get("kind").and_then(Value::as_str).ok_or("备份二进制描述缺少类型")?;
        if let Some(reference) = descriptor.get("ref") {
            if !matches!(kind, "Blob" | "File" | "ArrayBuffer") { return Err("不支持的备份二进制类型".into()); }
            let id = reference.get("id").and_then(Value::as_str).ok_or("备份二进制引用缺少 ID")?;
            let size = reference.get("size").and_then(Value::as_u64).ok_or("备份二进制引用缺少大小")?;
            reference.get("type").and_then(Value::as_str).ok_or("备份二进制引用缺少类型")?;
            let blob = blobs.get(&BlobRef { namespace: namespace.into(), key: id.into() }).ok_or("备份缺少记录引用的二进制文件")?;
            // The transfer Content-Type may be application/octet-stream when a
            // JavaScript Blob intentionally has an empty type. The codec owns
            // its logical type; file integrity is checked by size and digest.
            if *blob != size { return Err("二进制引用与文件清单不一致".into()); }
        } else if !matches!(kind, "DataView" | "Int8Array" | "Uint8Array" | "Uint8ClampedArray" | "Int16Array" | "Uint16Array" | "Int32Array" | "Uint32Array" | "Float32Array" | "Float64Array" | "BigInt64Array" | "BigUint64Array") {
            return Err("不支持的备份二进制数组类型".into());
        }
    }
    data.get("value").ok_or("备份业务记录缺少值")?;
    let mut references = HashSet::new();
    MediaReferenceReader::new(data, envelope.pointer("/data/meta")).walk("value", false, &mut HashSet::new(), &mut references);
    if references.iter().any(|reference| !blobs.contains_key(reference)) { return Err("备份缺少业务记录引用的本地媒体文件".into()); }
    Ok(())
}

pub(crate) fn validate_records(records: &[Record], blobs: &[BlobInfo]) -> Result<()> {
    let mut sizes = HashMap::new();
    for blob in blobs {
        validate_blob_namespace(&blob.namespace)?;
        sizes.insert(BlobRef { namespace: blob.namespace.clone(), key: blob.key.clone() }, blob.size);
    }
    for record in records {
        validate_record_namespace(&record.namespace)?;
        if record.key.is_empty() || record.key.contains('\0') { return Err("记录包含无效存储键".into()); }
        validate_record(&record.value, &record.namespace, if record.namespace == "preferences" { "preference" } else { "value" }, &sizes)?;
    }
    Ok(())
}

// Archive and destination are picked by native dialogs. ZIP paths are inspected
// as names only; extraction always uses Storage's generated upload tickets.
pub fn import_backup(archive: &Path, target: &Path, cancel: &AtomicBool) -> Result<ImportResult> {
    canceled(cancel)?;
    if !target.is_dir() || fs::read_dir(target).map_err(|error| error.to_string())?.next().is_some() {
        return Err("请选择新的空目录，导入不会合并或覆盖已有数据".into());
    }
    let target = fs::canonicalize(target).map_err(|error| error.to_string())?;
    let file = File::open(archive).map_err(|error| format!("无法打开备份文件：{error}"))?;
    let mut zip = ZipArchive::new(file).map_err(|error| format!("无法读取 ZIP64 备份：{error}"))?;
    let mut names = HashSet::new();
    for index in 0..zip.len() {
        canceled(cancel)?;
        let entry = zip.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() || entry.enclosed_name().is_none() || entry.name().contains('\\') || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err("备份包含无效路径或符号链接".into());
        }
        if !names.insert(entry.name().to_owned()) { return Err("备份包含重复的 ZIP 条目".into()); }
    }
    let manifest: Manifest = {
        let entry = zip.by_name("manifest.json").map_err(|_| "备份缺少 manifest.json".to_string())?;
        serde_json::from_reader(entry).map_err(|_| "备份清单格式损坏或包含未知字段".to_string())?
    };
    if manifest.format != "infinite-canvas-backup" || manifest.version != 1 { return Err("不支持的完整备份格式".into()); }
    if manifest.counts.records != manifest.records.len() as u64 || manifest.counts.binaries != manifest.blobs.len() as u64 {
        return Err("备份清单数量不符".into());
    }
    let mut expected_paths = HashSet::from(["manifest.json".to_string()]);
    let mut record_keys = HashSet::new();
    let mut blobs = HashMap::new();
    let mut expected_bytes = 0u64;
    for entry in &manifest.records {
        validate_record_namespace(&entry.namespace)?;
        validate_entry(&entry.key, &entry.path, &entry.sha256, &mut expected_paths)?;
        if !valid_entry_path(&entry.path, "records/", ".json") { return Err("备份记录路径不符合格式".into()); }
        if !record_keys.insert((entry.namespace.clone(), entry.key.clone())) { return Err("备份包含重复的业务记录".into()); }
        expected_bytes = expected_bytes.checked_add(entry.size).ok_or("备份大小溢出")?;
    }
    for entry in &manifest.blobs {
        validate_blob_namespace(&entry.namespace)?;
        validate_entry(&entry.key, &entry.path, &entry.sha256, &mut expected_paths)?;
        if !valid_entry_path(&entry.path, "binaries/", ".bin") { return Err("备份文件路径不符合格式".into()); }
        if blobs.insert(BlobRef { namespace: entry.namespace.clone(), key: entry.key.clone() }, entry.size).is_some() { return Err("备份包含重复的媒体存储键".into()); }
        expected_bytes = expected_bytes.checked_add(entry.size).ok_or("备份大小溢出")?;
    }
    if names != expected_paths || manifest.counts.bytes != expected_bytes { return Err("备份文件列表或总大小不符".into()); }
    if fs2::available_space(&target).map_err(|error| error.to_string())? < expected_bytes { return Err("目标磁盘剩余空间不足".into()); }

    let mut records = Vec::new();
    for entry in &manifest.records {
        canceled(cancel)?;
        let mut file = zip.by_name(&entry.path).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        let (size, digest) = hash_reader(&mut bytes.as_slice(), None)?;
        check_digest(size, &digest, entry.size, &entry.sha256)?;
        let value = String::from_utf8(bytes).map_err(|_| "备份业务记录不是 UTF-8 文本".to_string())?;
        validate_record(&value, &entry.namespace, &entry.kind, &blobs)?;
        records.push(RecordMutation::Set { namespace: entry.namespace.clone(), key: entry.key.clone(), value });
    }
    for entry in &manifest.blobs {
        let mut file = zip.by_name(&entry.path).map_err(|error| error.to_string())?;
        let (size, digest) = hash_cancellable(&mut file, None, cancel)?;
        check_digest(size, &digest, entry.size, &entry.sha256)?;
    }

    // Only this owned subdirectory is modified until all bytes have been verified.
    // An interrupted import never puts the root marker in the destination.
    let staging = target.join(format!(".import-{}", Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let storage = Storage::create_import(&staging)?;
    for entry in &manifest.blobs {
        canceled(cancel)?;
        let upload = storage.create_blob_temp(&entry.namespace, &entry.key, None)?;
        let mut output = OpenOptions::new().write(true).truncate(true).open(&upload.path).map_err(|error| error.to_string())?;
        let mut file = zip.by_name(&entry.path).map_err(|error| error.to_string())?;
        let (size, digest) = hash_cancellable(&mut file, Some(&mut output), cancel)?;
        check_digest(size, &digest, entry.size, &entry.sha256)?;
        output.sync_all().map_err(|error| error.to_string())?;
        drop(output);
        storage.commit_blob(upload, &entry.mime)?;
    }
    canceled(cancel)?;
    storage.records_batch(records, None, None)?;
    crate::data_root::finish_import(storage, &target, cancel)?;
    Ok(ImportResult { records: manifest.records.len(), blobs: manifest.blobs.len(), bytes: expected_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use zip::write::SimpleFileOptions;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("infinite-canvas-backup-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn archive(root: &Path, value: &str, media: Option<&[u8]>, corrupt_hash: bool) -> PathBuf {
        let record_hash = format!("{:x}", Sha256::digest(value.as_bytes()));
        let blob_entries: Vec<Value> = media.into_iter().map(|bytes| json!({
            "namespace": "image_files", "key": "image:one", "path": "binaries/0.bin", "mime": "image/png",
            "size": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes))
        })).collect();
        let manifest = json!({
            "format": "infinite-canvas-backup", "version": 1,
            "records": [{"namespace":"app_state","key":"canvas","kind":"value","path":"records/0.json","size":value.len(),"sha256":if corrupt_hash {"0".repeat(64)} else {record_hash}}],
            "blobs": blob_entries,
            "counts": {"records": 1, "binaries": usize::from(media.is_some()), "bytes": value.len() + media.map_or(0, |bytes| bytes.len())}
        });
        let path = root.join("backup.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
        writer.start_file("records/0.json", options).unwrap();
        writer.write_all(value.as_bytes()).unwrap();
        if let Some(bytes) = media {
            writer.start_file("binaries/0.bin", options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        writer.finish().unwrap();
        path
    }

    fn record() -> String {
        json!({"format":"infinite-canvas-value","version":1,"data":{"json":{
            "value":{"storageKey":"image:one","url":""}, "binaries":[], "arrays":[], "nullObjects":[], "regexps":[], "collections":[]
        }}}).to_string()
    }

    #[test]
    fn zip64_import_validates_and_keeps_original_archive() {
        let root = TestDirectory::new();
        let target = root.0.join("destination");
        fs::create_dir(&target).unwrap();
        let source = archive(&root.0, &record(), Some(b"media"), false);
        let result = import_backup(&source, &target, &AtomicBool::new(false)).unwrap();
        assert_eq!((result.records, result.blobs), (1, 1));
        assert!(source.is_file());
        let storage = crate::bootstrap::open_existing_storage(&target).unwrap();
        let (path, _) = storage.resolve_blob("image_files", "image:one").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"media");
        assert_eq!(storage.records_get("app_state", "canvas").unwrap().unwrap(), record());
    }

    #[test]
    fn malformed_hash_and_missing_local_media_do_not_touch_destination() {
        let root = TestDirectory::new();
        let target = root.0.join("destination");
        fs::create_dir(&target).unwrap();
        for (media, corrupt_hash) in [(Some(b"media".as_slice()), true), (None, false)] {
            let source = archive(&root.0, &record(), media, corrupt_hash);
            assert!(import_backup(&source, &target, &AtomicBool::new(false)).is_err());
            assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        }
    }

    #[test]
    fn canceled_import_preserves_source_and_target() {
        let root = TestDirectory::new();
        let target = root.0.join("destination");
        fs::create_dir(&target).unwrap();
        let source = archive(&root.0, &record(), Some(b"media"), false);
        assert!(import_backup(&source, &target, &AtomicBool::new(true)).is_err());
        assert!(source.is_file());
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    }

    #[test]
    fn ordinary_text_paths_import_without_requiring_media_files() {
        let root = TestDirectory::new();
        let target = root.0.join("destination");
        fs::create_dir(&target).unwrap();
        let value = json!({"format":"infinite-canvas-value","version":1,"data":{"json":{
            "value":{"metadata":{"content":"file:///D:/notes.png","prompt":"{\"storageKey\":\"image:example\"}"}},
            "binaries":[],"arrays":[],"nullObjects":[],"regexps":[],"collections":[]
        }}}).to_string();
        let source = archive(&root.0, &value, None, false);
        assert!(import_backup(&source, &target, &AtomicBool::new(false)).is_ok());
        assert_eq!(Storage::open(&target).unwrap().records_get("app_state", "canvas").unwrap(), Some(value));
    }

    #[test]
    fn superjson_collections_keep_field_context_without_confusing_typed_urls() {
        let data = json!({
            "value":{"elsewhere":{},"references":null,"url":"image:ordinary-url","private":{},"text":"image:ordinary-text"},
            "collections":[
                {"node":null,"kind":"Set","entries":["audio:required","image:typed-url"]},
                {"node":null,"kind":"Map","entries":[["storageKey","custom:required"],["prompt","file:ordinary"]]}
            ]
        });
        let meta = json!({
            "referentialEqualities":{"value.elsewhere":["value.references","collections.0.node"],"value.private":["collections.1.node"]},
            "values":{"value.url":["URL"],"collections.0.entries.1":["URL"]}
        });
        let mut references = HashSet::new();
        MediaReferenceReader::new(&data, Some(&meta)).walk("value", false, &mut HashSet::new(), &mut references);
        assert_eq!(references, HashSet::from([
            BlobRef { namespace:"media_files".into(), key:"audio:required".into() },
            BlobRef { namespace:"media_files".into(), key:"custom:required".into() },
        ]));
    }

    #[test]
    fn javascript_codec_fixture_has_the_same_references_in_the_native_importer() {
        let envelope: Value = serde_json::from_str(include_str!("../../tests/fixtures/desktop-media-references.json")).unwrap();
        let mut references = HashSet::new();
        MediaReferenceReader::new(envelope.pointer("/data/json").unwrap(), envelope.pointer("/data/meta"))
            .walk("value", false, &mut HashSet::new(), &mut references);
        assert_eq!(references, HashSet::from([
            BlobRef { namespace:"image_files".into(), key:"image:required".into() },
            BlobRef { namespace:"image_files".into(), key:"image:serialized".into() },
            BlobRef { namespace:"media_files".into(), key:"audio:required".into() },
            BlobRef { namespace:"media_files".into(), key:"custom:required".into() },
            BlobRef { namespace:"media_files".into(), key:"video:escaped".into() },
        ]));
    }
}
