use std::{sync::Arc, time::Instant};
use axum::{body::Body, extract::{DefaultBodyLimit, Path, State}, http::{HeaderMap, HeaderValue, Method, Request, StatusCode}, middleware::{self, Next}, response::{IntoResponse, Response}, routing::{any, put}, Json, Router};
use futures_util::StreamExt;
use reqwest::Url;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use crate::{Host, SavePhase};
use crate::storage::{BLOB_CONFLICT, BLOB_MODIFIED};

type HttpResult = Result<Response, (StatusCode, String)>;

#[derive(Clone)]
pub struct RedirectTarget {
    url: Url,
    strip_sensitive: bool,
}

fn error(message: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, message.into())
}

pub async fn start(host: Arc<Host>, listener: std::net::TcpListener) -> Result<(), std::io::Error> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let router = Router::new()
        .route("/{token}/proxy/{*target}", any(proxy))
        .route("/{token}/redirect/{id}", any(redirect))
        .route("/{token}/blob/{namespace}/{key}", any(blob))
        .route("/{token}/save/{id}", put(save))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(host.clone(), authorize))
        .with_state(host);
    axum::serve(listener, router).await
}

fn allowed_origin(origin: &str) -> bool {
    matches!(origin, "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost")
        || (cfg!(debug_assertions) && matches!(origin, "http://localhost:23147" | "http://127.0.0.1:23147"))
}

async fn authorize(State(host): State<Arc<Host>>, request: Request<Body>, next: Next) -> Response {
    let token = request.uri().path().split('/').nth(1).unwrap_or_default();
    if token != host.token { return StatusCode::UNAUTHORIZED.into_response(); }
    let origin = request.headers().get("origin").cloned();
    if origin.as_ref().is_some_and(|value| !value.to_str().is_ok_and(allowed_origin)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let requested_headers = request.headers().get("access-control-request-headers").cloned();
    let mut response = if request.method() == Method::OPTIONS && request.headers().contains_key("access-control-request-method") {
        StatusCode::NO_CONTENT.into_response()
    } else { next.run(request).await };
    let headers = response.headers_mut();
    // Provider CORS policies are replaced with the exact local application's origin.
    let cors_headers: Vec<_> = headers.keys().filter(|key| key.as_str().starts_with("access-control-")).cloned().collect();
    for name in cors_headers { headers.remove(name); }
    if let Some(origin) = origin {
        headers.insert("access-control-allow-origin", origin);
        headers.insert("vary", HeaderValue::from_static("Origin"));
        headers.insert("access-control-allow-methods", HeaderValue::from_static("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"));
        headers.insert("access-control-expose-headers", HeaderValue::from_static("*"));
        if let Some(requested) = requested_headers { headers.insert("access-control-allow-headers", requested); }
    }
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

async fn proxy(State(host): State<Arc<Host>>, Path((_token, target)): Path<(String, String)>, request: Request<Body>) -> HttpResult {
    let url = proxy_target(&target, request.uri().query())?;
    forward(host, RedirectTarget { url, strip_sensitive: false }, request).await
}

fn proxy_target(target: &str, query: Option<&str>) -> Result<Url, (StatusCode, String)> {
    let mut url = Url::parse(target).map_err(|_| error("目标地址无效"))?;
    if let Some(query) = query.filter(|query| !query.is_empty()) {
        // Axios has already serialized these parameters. Preserve their escaping and order.
        let combined = match url.query().filter(|value| !value.is_empty()) {
            Some(existing) => format!("{existing}&{query}"),
            None => query.to_owned(),
        };
        url.set_query(Some(&combined));
    }
    Ok(url)
}

fn storage_write_error(message: String) -> (StatusCode, String) {
    if message == BLOB_CONFLICT || message == BLOB_MODIFIED { (StatusCode::CONFLICT, message) }
    else { error(message) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_query_preserves_existing_signatures_and_appended_parameters() {
        let target = "https://provider.test/prediction?signature=a%2Bb%3D&part=first";
        assert_eq!(proxy_target(target, None).unwrap().as_str(), target);
        assert_eq!(proxy_target(target, Some("")).unwrap().as_str(), target);
        assert_eq!(proxy_target(target, Some("task_id=123&part=second&tags%5B%5D=a+z")).unwrap().as_str(),
            "https://provider.test/prediction?signature=a%2Bb%3D&part=first&task_id=123&part=second&tags%5B%5D=a+z");
        assert_eq!(proxy_target("https://provider.test/prediction", Some("token=%E4%B8%AD%2F%2B")).unwrap().query(), Some("token=%E4%B8%AD%2F%2B"));
    }

    #[test]
    fn only_explicit_media_conflicts_are_non_retryable() {
        assert_eq!(storage_write_error(BLOB_CONFLICT.into()).0, StatusCode::CONFLICT);
        assert_eq!(storage_write_error(BLOB_MODIFIED.into()).0, StatusCode::CONFLICT);
        assert_ne!(storage_write_error("本地文件操作失败：磁盘空间不足".into()).0, StatusCode::CONFLICT);
    }
}

async fn redirect(State(host): State<Arc<Host>>, Path((_token, id)): Path<(String, String)>, request: Request<Body>) -> HttpResult {
    let target = host.redirects.lock().map_err(|_| error("重定向状态不可用"))?
        .get(&id).cloned().ok_or_else(|| error("重定向地址已失效"))?;
    forward(host, target, request).await
}

fn remove_connection_headers(headers: &mut HeaderMap) {
    if let Some(connection) = headers.get("connection").and_then(|value| value.to_str().ok()).map(str::to_owned) {
        for name in connection.split(',').map(str::trim) { headers.remove(name); }
    }
    for name in ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"] {
        headers.remove(name);
    }
}

async fn forward(host: Arc<Host>, target: RedirectTarget, request: Request<Body>) -> HttpResult {
    let url = &target.url;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(error("模型请求只允许无内嵌凭据的 HTTP 或 HTTPS 地址"));
    }
    if matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1" | "[::1]")) && url.port() == Some(host.port) {
        return Err(error("不能再次代理桌面运行时地址"));
    }
    let client = host.network.read().map_err(|_| error("网络设置不可用"))?
        .client.clone().map_err(|message| (StatusCode::BAD_GATEWAY, message))?;
    let (parts, body) = request.into_parts();
    let method = parts.method;
    let mut headers = parts.headers;
    remove_connection_headers(&mut headers);
    // A cookie on this request belongs to the loopback origin, never the remote provider.
    for name in ["origin", "referer", "cookie", "x-desktop-lease"] { headers.remove(name); }
    let browser_headers: Vec<_> = headers.keys().filter(|key| key.as_str().starts_with("sec-")).cloned().collect();
    for name in browser_headers { headers.remove(name); }
    if target.strip_sensitive {
        headers.remove("authorization");
    }
    let started = Instant::now();
    let outgoing = client.request(method.clone(), url.clone()).headers(headers);
    let outgoing = if method == Method::GET || method == Method::HEAD { outgoing }
        else { outgoing.body(reqwest::Body::wrap_stream(body.into_data_stream())) };
    let remote = outgoing.send().await
        .map_err(|failure| {
            let category = if failure.is_connect() { "连接失败，请检查网络与代理设置" } else if failure.is_timeout() { "上游连接超时" } else { "请求传输失败" };
            (StatusCode::BAD_GATEWAY, category.to_owned())
        })?;
    let status = remote.status();
    let mut response_headers = remote.headers().clone();
    remove_connection_headers(&mut response_headers);
    response_headers.remove("set-cookie");
    if status.is_redirection() {
        if let Some(location) = response_headers.get("location").and_then(|value| value.to_str().ok()) {
            let next = url.join(location).map_err(|_| error("上游重定向地址无效"))?;
            if !matches!(next.scheme(), "http" | "https") { return Err(error("上游重定向协议不支持")); }
            let strip_sensitive = target.strip_sensitive || next.origin() != url.origin();
            let id = uuid::Uuid::new_v4().to_string();
            host.redirects.lock().map_err(|_| error("重定向状态不可用"))?
                .insert(id.clone(), RedirectTarget { url: next, strip_sensitive });
            response_headers.insert("location", HeaderValue::from_str(&format!("{}/redirect/{id}", host.api_base)).map_err(|_| error("重定向地址无效"))?);
        }
    }
    // Never log target paths/queries, credentials, request bodies, or session capability URLs.
    eprintln!("proxy {} {} {} {}ms", method, url.origin().ascii_serialization(), status.as_u16(), started.elapsed().as_millis());
    let mut response = Response::new(Body::from_stream(remote.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    Ok(response)
}

async fn blob(State(host): State<Arc<Host>>, Path((_token, namespace, key)): Path<(String, String, String)>, request: Request<Body>) -> HttpResult {
    match *request.method() {
        Method::GET | Method::HEAD => {
            let (path, info) = host.storage.resolve_blob(&namespace, &key)
                .map_err(|message| (StatusCode::NOT_FOUND, message))?;
            let served = ServeFile::new(path).oneshot(request).await
                .unwrap_or_else(|never| match never {});
            let mut response = served.map(Body::new);
            if let Ok(mime) = HeaderValue::from_str(&info.mime) { response.headers_mut().insert("content-type", mime); }
            Ok(response)
        },
        Method::PUT => {
            let mime = request.headers().get("content-type").and_then(|header| header.to_str().ok()).unwrap_or("application/octet-stream").to_owned();
            let lease = request.headers().get("x-desktop-lease").and_then(|header| header.to_str().ok());
            let upload = host.storage.create_blob_temp(&namespace, &key, lease).map_err(error)?;
            let mut file = tokio::fs::OpenOptions::new().write(true).truncate(true).open(&upload.path).await
                .map_err(|failure| error(format!("无法写入媒体：{failure}")))?;
            let mut stream = request.into_body().into_data_stream();
            while let Some(chunk) = stream.next().await {
                file.write_all(&chunk.map_err(|_| error("媒体上传中断"))?).await
                    .map_err(|failure| error(format!("媒体保存失败：{failure}")))?;
            }
            file.flush().await.map_err(|failure| error(format!("媒体保存失败：{failure}")))?;
            file.sync_all().await.map_err(|failure| error(format!("媒体保存失败：{failure}")))?;
            drop(file);
            let storage = host.storage.clone();
            let info = tauri::async_runtime::spawn_blocking(move || storage.commit_blob(upload, &mime)).await
                .map_err(|_| error("媒体保存任务中断"))?.map_err(storage_write_error)?;
            Ok(Json(info).into_response())
        },
        _ => Ok(StatusCode::METHOD_NOT_ALLOWED.into_response()),
    }
}

async fn save(State(host): State<Arc<Host>>, Path((_token, id)): Path<(String, String)>, request: Request<Body>) -> HttpResult {
    let offset = request.headers().get("x-desktop-offset").and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok()).ok_or_else(|| error("文件分块偏移无效"))?;
    let job = host.saves.lock().map_err(|_| error("保存状态不可用"))?
        .get(&id).cloned().ok_or_else(|| error("保存文件操作已取消"))?;
    {
        let mut phase = job.phase.lock().map_err(|_| error("保存状态不可用"))?;
        if matches!(*phase, SavePhase::Uploading | SavePhase::Committed) { return Err(error("文件正在写入或已经提交")); }
        *phase = SavePhase::Uploading;
    }
    let result: Result<(), String> = async {
        let mut file = tokio::fs::OpenOptions::new().append(true).open(&job.temporary).await.map_err(|failure| failure.to_string())?;
        if file.metadata().await.map_err(|failure| failure.to_string())?.len() != offset {
            return Err("文件分块顺序不一致，已取消保存".into());
        }
        let mut chunks = request.into_body().into_data_stream();
        while let Some(chunk) = chunks.next().await {
            if job.cancelled.load(std::sync::atomic::Ordering::Relaxed) { return Err("保存已取消".into()); }
            file.write_all(&chunk.map_err(|_| "保存数据流中断")?).await.map_err(|failure| failure.to_string())?;
        }
        file.flush().await.map_err(|failure| failure.to_string())?;
        if job.cancelled.load(std::sync::atomic::Ordering::Relaxed) { return Err("保存已取消".into()); }
        *job.phase.lock().map_err(|_| "保存状态不可用")? = SavePhase::Uploaded;
        Ok(())
    }.await;
    if let Err(message) = result {
        if let Ok(mut saves) = host.saves.lock() { saves.remove(&id); }
        return Err(error(message));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
