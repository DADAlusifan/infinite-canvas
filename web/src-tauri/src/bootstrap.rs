use std::{fs, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use crate::storage::{Storage, DATABASE_FILE, MARKER_FILE};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap { data_root: PathBuf }

fn environment() -> &'static str { if cfg!(debug_assertions) { "development" } else { "production" } }

fn check_environment(root: &Path) -> Result<(), String> {
    let marker = root.join("desktop-environment.json");
    if marker.exists() {
        let saved: String = serde_json::from_slice(&fs::read(&marker).map_err(|error| error.to_string())?)
            .map_err(|_| "桌面环境标记损坏，请保留原文件并修复")?;
        if saved != environment() { return Err("开发环境和正式版必须使用不同数据目录，请选择对应环境的目录。".into()); }
    }
    Ok(())
}

pub(crate) fn write_environment_marker(root: &Path) -> Result<(), String> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(root.join("desktop-environment.json"))
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, environment()).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

pub(crate) fn open_storage(root: &Path) -> Result<Storage, String> {
    check_environment(root)?;
    let storage = Storage::open(root)?;
    if !root.join("desktop-environment.json").exists() { write_environment_marker(root)?; }
    Ok(storage)
}

pub(crate) fn open_existing_storage(root: &Path) -> Result<Storage, String> {
    // Switching must never create an empty replacement database or adopt an
    // unknown directory. Imported/copied directories are stamped before ready.
    if !root.is_dir() || !root.join(MARKER_FILE).is_file() || !root.join(DATABASE_FILE).is_file() {
        return Err("请选择已有的完整应用数据目录；空目录请使用复制当前数据。".into());
    }
    if !root.join("desktop-environment.json").is_file() {
        return Err("数据目录缺少桌面环境标记，未修改原数据。".into());
    }
    check_environment(root)?;
    Storage::open_existing(root)
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_config_dir().map_err(|error| error.to_string())?;
    Ok(directory.join(if cfg!(debug_assertions) { "desktop-dev.json" } else { "desktop.json" }))
}

pub fn write(path: &Path, root: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("启动配置目录无效")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = path.with_extension("pending");
    fs::write(&temp, serde_json::to_vec(&Bootstrap { data_root: root.to_path_buf() }).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    // On Windows replace the small locator atomically rather than removing the old locator first.
    atomic_replace(&temp, path)
}

pub fn open(app: &AppHandle) -> Result<Option<(PathBuf, Storage)>, String> {
    let path = config_path(app)?;
    if path.exists() {
        let value: Bootstrap = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|_| "启动配置损坏；请保留原文件，修复或手动恢复数据目录定位".to_string())?;
        if !value.data_root.is_dir() {
            return Err("数据目录当前无法访问。请重新连接磁盘后启动，应用不会创建空数据库替代。".into());
        }
        let storage = open_existing_storage(&value.data_root)?;
        return Ok(Some((path, storage)));
    }
    rfd::MessageDialog::new().set_title("选择 Infinite Canvas 数据目录")
        .set_description(if cfg!(debug_assertions) {
            "这是桌面开发环境。请选择专用空文件夹或已有的开发数据目录；不要选择正式版目录。媒体、数据库及 WebView 缓存将保存在这里。"
        } else {
            "请选择专用空文件夹（可位于 D 盘）或已有的 Infinite Canvas 数据目录。媒体、数据库及 WebView 缓存将保存在这里。"
        }).show();
    let Some(root) = rfd::FileDialog::new().set_title("选择专用数据文件夹").pick_folder() else { return Ok(None); };
    let storage = open_storage(&root)?;
    write(&path, &root)?;
    Ok(Some((path, storage)))
}

pub fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    { fs::rename(source, destination).map_err(|error| error.to_string()) }
}
