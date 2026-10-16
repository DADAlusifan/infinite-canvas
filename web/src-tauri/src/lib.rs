mod backup;
mod bootstrap;
mod commands;
mod data_root;
mod http;
mod network;
mod storage;

use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex, RwLock, atomic::AtomicBool}};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use network::Network;
use storage::Storage;

enum SavePhase { Ready, Uploading, Uploaded, Committed }

struct SaveJob {
    target: PathBuf,
    temporary: PathBuf,
    phase: Mutex<SavePhase>,
    cancelled: AtomicBool,
}

impl Drop for SaveJob {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.temporary); }
}

struct ImportJob {
    token: String,
    cancelled: Arc<AtomicBool>,
    ready_root: Option<PathBuf>,
}

struct Host {
    storage: Arc<Storage>,
    bootstrap: PathBuf,
    api_base: String,
    token: String,
    port: u16,
    network: RwLock<Network>,
    saves: Mutex<HashMap<String, Arc<SaveJob>>>,
    redirects: Mutex<HashMap<String, http::RedirectTarget>>,
    import: Mutex<Option<ImportJob>>,
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::desktop_runtime,
            commands::desktop_network_set,
            commands::desktop_records_get,
            commands::desktop_records_list,
            commands::desktop_records_batch,
            commands::desktop_storage_revision,
            commands::desktop_storage_flush,
            commands::desktop_storage_usage,
            commands::desktop_blob_list,
            commands::desktop_maintenance_begin,
            commands::desktop_maintenance_end,
            commands::desktop_cleanup_preview,
            commands::desktop_cleanup_commit,
            commands::desktop_save_begin,
            commands::desktop_save_finish,
            commands::desktop_save_cancel,
            commands::desktop_open_data_root,
            commands::desktop_reveal_blob,
            commands::desktop_open_external,
            commands::desktop_import_backup,
            commands::desktop_change_data_root,
            commands::desktop_import_cancel,
            commands::desktop_restart_to_import,
        ])
        .setup(|app| {
            let Some((bootstrap, storage)) = bootstrap::open(app.handle()).map_err(std::io::Error::other)? else {
                app.handle().exit(0);
                return Ok(());
            };
            let network = storage.records_get("preferences", "infinite-canvas:desktop-network")?
                .map(|value| serde_json::from_str(&value)).transpose()?.unwrap_or_default();
            let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
            let port = listener.local_addr()?.port();
            let token = uuid::Uuid::new_v4().simple().to_string();
            let cache = storage.root().join("cache/webview");
            std::fs::create_dir_all(&cache)?;
            let host = Arc::new(Host {
                storage: Arc::new(storage), bootstrap,
                api_base: format!("http://127.0.0.1:{port}/{token}"), token, port,
                network: RwLock::new(Network::new(network)),
                saves: Mutex::new(HashMap::new()), redirects: Mutex::new(HashMap::new()), import: Mutex::new(None),
            });
            app.manage(host.clone());
            tauri::async_runtime::spawn(async move {
                if http::start(host, listener).await.is_err() {
                    eprintln!("桌面本地资源服务停止，请重启应用；未修改存储数据。");
                }
            });
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(if cfg!(debug_assertions) { "Infinite Canvas · 开发环境" } else { "Infinite Canvas" })
                .inner_size(1440.0, 960.0)
                .data_directory(cache)
                .disable_drag_drop_handler()
                .on_navigation(|url| {
                    let internal = url.as_str() == "about:blank"
                        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") && url.port().is_none())
                        || (cfg!(debug_assertions) && url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1")) && url.port() == Some(23147));
                    if internal { return true; }
                    if matches!(url.scheme(), "http" | "https") { let _ = open::that(url.as_str()); }
                    false
                })
                .on_new_window(|url, _features| {
                    if matches!(url.scheme(), "http" | "https") { let _ = open::that(url.as_str()); }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|_, _| {}),
        Err(error) => {
            rfd::MessageDialog::new().set_title("Infinite Canvas 启动失败")
                .set_description(format!("{error}\n\n原数据已保留，请修复后重新启动。"))
                .set_level(rfd::MessageLevel::Error).show();
        },
    }
}
