use std::{fs::OpenOptions, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use crate::{backup, bootstrap, data_root, Host, ImportJob, SaveJob, SavePhase, network::{Network, NetworkSettings}, storage::{BlobInfo, BlobRef, CleanupPreview, CleanupResult, Record, RecordMutation, Snapshot, StorageUsage}};

type Result<T> = std::result::Result<T, String>;
type Desktop<'a> = State<'a, Arc<Host>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    data_root: String,
    api_base: String,
    network: NetworkSettings,
    network_error: Option<String>,
}

#[tauri::command]
pub fn desktop_runtime(host: Desktop<'_>) -> Result<Runtime> {
    let network = host.network.read().map_err(|_| "网络设置不可用")?;
    Ok(Runtime {
        data_root: host.storage.root().to_string_lossy().into_owned(), api_base: host.api_base.clone(),
        network: network.settings.clone(), network_error: network.client.as_ref().err().cloned(),
    })
}

#[tauri::command]
pub fn desktop_network_set(host: Desktop<'_>, network: NetworkSettings) -> Result<NetworkSettings> {
    let next = Network::new(network.clone());
    if let Err(message) = &next.client { return Err(message.clone()); }
    host.storage.records_batch(vec![RecordMutation::Set {
        namespace: "preferences".into(), key: "infinite-canvas:desktop-network".into(),
        value: serde_json::to_string(&network).map_err(|error| error.to_string())?,
    }], None, None)?;
    *host.network.write().map_err(|_| "网络设置不可用")? = next;
    Ok(network)
}

#[tauri::command]
pub fn desktop_records_get(host: Desktop<'_>, namespace: String, key: String) -> Result<Option<String>> {
    host.storage.records_get(&namespace, &key)
}

#[tauri::command]
pub fn desktop_records_list(host: Desktop<'_>, namespace: Option<String>) -> Result<Vec<Record>> {
    host.storage.records_list(namespace.as_deref())
}

#[tauri::command]
pub fn desktop_records_batch(host: Desktop<'_>, mutations: Vec<RecordMutation>, expected_revision: Option<u64>, lease: Option<String>) -> Result<u64> {
    host.storage.records_batch(mutations, expected_revision, lease.as_deref())
}

#[tauri::command]
pub fn desktop_storage_revision(host: Desktop<'_>) -> Result<u64> { host.storage.revision() }

#[tauri::command]
pub fn desktop_storage_flush(host: Desktop<'_>) -> Result<()> { host.storage.flush() }

#[tauri::command]
pub fn desktop_storage_usage(host: Desktop<'_>) -> Result<StorageUsage> { host.storage.usage() }

#[tauri::command]
pub fn desktop_blob_list(host: Desktop<'_>, namespace: Option<String>) -> Result<Vec<BlobInfo>> { host.storage.blob_list(namespace.as_deref()) }

#[tauri::command]
pub fn desktop_maintenance_begin(host: Desktop<'_>) -> Result<Snapshot> { host.storage.begin_maintenance() }

#[tauri::command]
pub fn desktop_maintenance_end(host: Desktop<'_>, token: String) -> Result<()> { host.storage.end_maintenance(&token) }

#[tauri::command]
pub fn desktop_cleanup_preview(host: Desktop<'_>, references: Vec<BlobRef>, lease: Option<String>) -> Result<CleanupPreview> {
    host.storage.cleanup_preview(references, lease.as_deref())
}

#[tauri::command]
pub fn desktop_cleanup_commit(host: Desktop<'_>, references: Vec<BlobRef>, expected_revision: u64, lease: Option<String>) -> Result<CleanupResult> {
    host.storage.cleanup_commit(references, expected_revision, lease.as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTicket { id: String, upload_url: String }

#[tauri::command]
pub async fn desktop_save_begin(host: Desktop<'_>, default_name: String) -> Result<Option<SaveTicket>> {
    // User-chosen save locations become single-use capabilities, never raw write paths in JavaScript.
    let destination = rfd::AsyncFileDialog::new().set_file_name(&default_name).save_file().await;
    let Some(destination) = destination else { return Ok(None); };
    let target = destination.path().to_path_buf();
    let parent = target.parent().ok_or("保存位置无效")?;
    let id = uuid::Uuid::new_v4().to_string();
    let temporary = parent.join(format!(".infinite-canvas-{id}.partial"));
    OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
    host.saves.lock().map_err(|_| "保存状态不可用")?.insert(id.clone(), Arc::new(SaveJob {
        target, temporary, phase: Mutex::new(SavePhase::Ready), cancelled: AtomicBool::new(false),
    }));
    Ok(Some(SaveTicket { upload_url: format!("{}/save/{id}", host.api_base), id }))
}

#[tauri::command]
pub fn desktop_save_finish(host: Desktop<'_>, id: String) -> Result<()> {
    let mut saves = host.saves.lock().map_err(|_| "保存状态不可用")?;
    let job = saves.get(&id).cloned().ok_or("保存操作已取消")?;
    let mut phase = job.phase.lock().map_err(|_| "保存状态不可用")?;
    if matches!(*phase, SavePhase::Uploading | SavePhase::Committed) {
        return Err("文件尚未写入完成".into());
    }
    let file = OpenOptions::new().write(true).open(&job.temporary).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    bootstrap::atomic_replace(&job.temporary, &job.target)?;
    *phase = SavePhase::Committed;
    saves.remove(&id);
    Ok(())
}

#[tauri::command]
pub fn desktop_save_cancel(host: Desktop<'_>, id: String) -> Result<()> {
    if let Some(job) = host.saves.lock().map_err(|_| "保存状态不可用")?.remove(&id) {
        job.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_open_data_root(host: Desktop<'_>) -> Result<()> {
    open::that(host.storage.root()).map_err(|_| "无法打开数据目录".into())
}

#[tauri::command]
pub fn desktop_reveal_blob(host: Desktop<'_>, namespace: String, key: String) -> Result<()> {
    let (file, _) = host.storage.resolve_blob(&namespace, &key)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe").arg(format!("/select,{}", file.display()))
            .creation_flags(0x08000000).spawn().map_err(|_| "无法定位媒体文件")?;
        Ok(())
    }
    #[cfg(not(windows))]
    { open::that(file.parent().ok_or("媒体目录无效")?).map_err(|_| "无法打开媒体目录".into()) }
}

#[tauri::command]
pub fn desktop_open_external(url: String) -> Result<()> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "链接无效")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("只能打开 HTTP 或 HTTPS 外部链接".into());
    }
    open::that(parsed.as_str()).map_err(|_| "无法打开外部链接".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    token: String,
    ready_to_switch: bool,
    data_root: String,
    records: usize,
    blobs: usize,
    bytes: u64,
}

#[tauri::command]
pub async fn desktop_import_backup(host: Desktop<'_>) -> Result<Option<Imported>> {
    let token = uuid::Uuid::new_v4().to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut state = host.import.lock().map_err(|_| "导入状态不可用")?;
        if state.is_some() { return Err("已有备份正在导入或等待切换".into()); }
        *state = Some(ImportJob { token: token.clone(), cancelled: cancelled.clone(), ready_root: None });
    }
    let outcome: Result<Option<(PathBuf, backup::ImportResult)>> = async {
        let Some(archive) = rfd::AsyncFileDialog::new().set_title("选择完整备份包").add_filter("完整备份", &["zip"]).pick_file().await else { return Ok(None); };
        let Some(target) = rfd::AsyncFileDialog::new().set_title("选择新建的空数据目录").pick_folder().await else { return Ok(None); };
        let archive = archive.path().to_path_buf();
        let target = target.path().to_path_buf();
        let target_copy = target.clone();
        let result = tauri::async_runtime::spawn_blocking(move || backup::import_backup(&archive, &target_copy, &cancelled)).await
            .map_err(|_| "备份导入任务中断")??;
        Ok(Some((target, result)))
    }.await;
    let mut state = host.import.lock().map_err(|_| "导入状态不可用")?;
    match outcome {
        Ok(Some((target, result))) => {
            let job = state.as_mut().ok_or("导入已取消")?;
            if job.cancelled.load(Ordering::Relaxed) { *state = None; return Err("导入已取消，原数据未修改".into()); }
            job.ready_root = Some(target.clone());
            Ok(Some(Imported { token, ready_to_switch: true, data_root: target.to_string_lossy().into_owned(), records: result.records, blobs: result.blobs, bytes: result.bytes }))
        },
        Ok(None) => { *state = None; Ok(None) },
        Err(error) => { *state = None; Err(error) },
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataRootMode { Copy, Open }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDataRoot { token: String, data_root: String }

#[tauri::command]
pub async fn desktop_change_data_root(host: Desktop<'_>, mode: DataRootMode, lease: String) -> Result<Option<ChangedDataRoot>> {
    // Require the same native maintenance lease that protects all browser-side
    // save queues; a direct command invocation cannot copy a live changing DB.
    let snapshot = host.storage.maintenance_snapshot(&lease)?;
    let revision = snapshot.revision;
    host.storage.flush()?;
    let token = uuid::Uuid::new_v4().to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut state = host.import.lock().map_err(|_| "导入状态不可用")?;
        if state.is_some() { return Err("已有备份或数据目录正在准备切换，请先完成或取消该操作".into()); }
        *state = Some(ImportJob { token: token.clone(), cancelled: cancelled.clone(), ready_root: None });
    }
    let outcome: Result<Option<PathBuf>> = async {
        let title = match mode { DataRootMode::Copy => "选择新的空目录，复制当前数据后重启", DataRootMode::Open => "选择已有的应用数据目录，切换后重启" };
        let Some(target) = rfd::AsyncFileDialog::new().set_title(title).pick_folder().await else { return Ok(None); };
        let target = target.path().to_path_buf();
        let source = host.storage.clone();
        let target = tauri::async_runtime::spawn_blocking(move || {
            let target = data_root::independent_target(source.root(), &target)?;
            match mode {
                DataRootMode::Copy => data_root::copy_current(&source, snapshot, &target, &cancelled)?,
                DataRootMode::Open => {
                    let storage = bootstrap::open_existing_storage(&target)?;
                    data_root::verify_media(&storage, &cancelled)?;
                    storage.flush()?;
                },
            }
            Ok::<_, String>(target)
        }).await.map_err(|_| "数据目录操作中断，原数据未修改")??;
        if host.storage.maintenance_snapshot(&lease)?.revision != revision {
            return Err("操作期间源数据已变化，未切换数据目录".into());
        }
        Ok(Some(target))
    }.await;
    let mut state = host.import.lock().map_err(|_| "导入状态不可用")?;
    match outcome {
        Ok(Some(root)) => {
            let job = state.as_mut().ok_or("数据目录操作已取消")?;
            if job.cancelled.load(Ordering::Relaxed) { *state = None; return Err("已取消更改数据目录，原数据未修改".into()); }
            job.ready_root = Some(root.clone());
            Ok(Some(ChangedDataRoot { token, data_root: root.to_string_lossy().into_owned() }))
        },
        Ok(None) => { *state = None; Ok(None) },
        Err(error) => { *state = None; Err(error) },
    }
}

#[tauri::command]
pub fn desktop_import_cancel(host: Desktop<'_>) -> Result<()> {
    let mut state = host.import.lock().map_err(|_| "导入状态不可用")?;
    if let Some(job) = state.as_ref() {
        job.cancelled.store(true, Ordering::Relaxed);
        if job.ready_root.is_some() { *state = None; }
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_restart_to_import(app: AppHandle, host: Desktop<'_>, token: String) -> Result<()> {
    let root = {
        let state = host.import.lock().map_err(|_| "导入状态不可用")?;
        let job = state.as_ref().ok_or("没有可切换的完整备份")?;
        if job.token != token || job.cancelled.load(Ordering::Relaxed) { return Err("导入会话无效".into()); }
        job.ready_root.clone().ok_or("导入尚未完成")?
    };
    host.storage.flush()?;
    // Validate again immediately before changing the locator: the prepared
    // directory may have been removed, locked or replaced while awaiting UI.
    let destination = bootstrap::open_existing_storage(&root)?;
    destination.flush()?;
    bootstrap::write(&host.bootstrap, &root)?;
    drop(destination);
    // Run normal Exit handlers so the single-instance mutex is released before relaunch.
    app.request_restart();
    Ok(())
}
