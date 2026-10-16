use reqwest::{Client, Proxy, Url};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode { System, Direct, Manual }

#[derive(Clone, Serialize, Deserialize)]
pub struct NetworkSettings {
    pub mode: NetworkMode,
    #[serde(default)]
    pub url: String,
}

impl Default for NetworkSettings {
    fn default() -> Self { Self { mode: NetworkMode::System, url: String::new() } }
}

pub struct Network {
    pub settings: NetworkSettings,
    pub client: Result<Client, String>,
}

impl Network {
    pub fn new(settings: NetworkSettings) -> Self {
        let client = build_client(&settings);
        Self { settings, client }
    }
}

fn proxy_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    let normalized = if value.contains("://") { value.to_owned() } else { format!("http://{value}") };
    let url = Url::parse(&normalized).map_err(|_| "代理地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h") || url.host_str().is_none() {
        return Err("代理地址必须使用 http、https、socks5 或 socks5h".into());
    }
    Ok(normalized)
}

fn build_client(settings: &NetworkSettings) -> Result<Client, String> {
    // Disable environment proxies and protocol retries: this application owns the chosen mode.
    let mut builder = Client::builder().no_proxy().retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none());
    match settings.mode {
        NetworkMode::Direct => {},
        NetworkMode::Manual => {
            let routes = vec![(String::new(), proxy_url(&settings.url)?)];
            builder = builder.proxy(Proxy::custom(move |url| proxy_target(url, &routes, &[])));
        },
        NetworkMode::System => {
            if let Some(proxy) = system_proxy()? { builder = builder.proxy(proxy); }
        },
    }
    builder.build().map_err(|_| "无法初始化网络代理".to_string())
}

fn is_loopback(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").trim_end_matches('.');
    host.eq_ignore_ascii_case("localhost")
        || host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn proxy_target(url: &Url, routes: &[(String, String)], exclusions: &[String]) -> Option<String> {
    // Local model servers must stay local even if the chosen proxy has no bypass list.
    if is_loopback(url) { return None; }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let host_port = match url.port() { Some(port) => format!("{host}:{port}"), None => host.clone() };
    let bypassed = exclusions.iter().any(|pattern| {
        if pattern == "<local>" { return !host.contains('.'); }
        if pattern == &host || pattern == &host_port { return true; }
        glob::Pattern::new(pattern).map(|glob| glob.matches(&host) || glob.matches(&host_port)).unwrap_or(false)
    });
    if bypassed { return None; }
    routes.iter().find(|(scheme, _)| scheme == url.scheme())
        .or_else(|| routes.iter().find(|(scheme, _)| scheme.is_empty() || scheme == "socks"))
        .map(|(_, address)| address.clone())
}

#[cfg(windows)]
fn system_proxy() -> Result<Option<Proxy>, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .map_err(|_| "无法读取 Windows 系统代理，请在网络设置中选择直连或手动代理")?;
    let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    let server: String = key.get_value("ProxyServer").unwrap_or_default();
    let pac: String = key.get_value("AutoConfigURL").unwrap_or_default();
    let auto_detect: u32 = key.get_value("AutoDetect").unwrap_or(0);
    let connection_auto_detect = key.open_subkey("Connections").ok()
        .and_then(|connections| connections.get_raw_value("DefaultConnectionSettings").ok())
        .and_then(|value| value.bytes.get(8).copied())
        .map(|flags| flags & 8 != 0).unwrap_or(false);
    if enabled == 0 || server.trim().is_empty() {
        if !pac.is_empty() || auto_detect != 0 || connection_auto_detect {
            return Err("系统仅配置 PAC/WPAD 自动代理，桌面版暂不执行自动代理脚本。请选择手动代理或直连。".into());
        }
        return Ok(None);
    }
    let bypass: String = key.get_value("ProxyOverride").unwrap_or_default();
    let exclusions: Vec<String> = bypass.split(';').map(str::trim)
        .filter(|part| !part.is_empty()).map(str::to_ascii_lowercase).collect();
    let mut routes = Vec::new();
    for part in server.split(';').filter(|part| !part.trim().is_empty()) {
        if let Some((scheme, address)) = part.split_once('=') {
            let scheme = scheme.trim().to_ascii_lowercase();
            let address = if scheme == "socks" && !address.contains("://") { format!("socks5://{}", address.trim()) } else { address.to_owned() };
            routes.push((scheme, proxy_url(&address)?));
        } else {
            routes.push((String::new(), proxy_url(part)?));
        }
    }
    Ok(Some(Proxy::custom(move |url| proxy_target(url, &routes, &exclusions))))
}

#[cfg(not(windows))]
fn system_proxy() -> Result<Option<Proxy>, String> {
    Err("此桌面版本仅支持 Windows；请选择明确的网络模式".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_proxy_never_receives_loopback_model_requests() {
        let routes = vec![(String::new(), "http://proxy.example:8080".into())];
        for address in [
            "http://localhost:8000/v1/images/generations", "http://LOCALHOST.:8000/",
            "http://127.0.0.1:8000/", "http://127.23.45.67:8000/", "http://127.1:8000/",
            "http://[::1]:8000/", "http://[0:0:0:0:0:0:0:1]:8000/",
        ] {
            assert_eq!(proxy_target(&Url::parse(address).unwrap(), &routes, &[]), None, "{address}");
        }
        assert_eq!(proxy_target(&Url::parse("https://api.example/v1/models").unwrap(), &routes, &[]), Some("http://proxy.example:8080".into()));
        assert_eq!(proxy_target(&Url::parse("https://localhost.example/v1/models").unwrap(), &routes, &[]), Some("http://proxy.example:8080".into()));
    }

    #[test]
    fn system_proxy_keeps_scheme_routes_and_user_exclusions_after_loopback_bypass() {
        let routes = vec![("http".into(), "http://proxy-http.example:80".into()), ("https".into(), "http://proxy-https.example:8080".into())];
        let exclusions = vec!["*.internal.example".into()];
        assert_eq!(proxy_target(&Url::parse("https://127.255.0.1:8443/").unwrap(), &routes, &exclusions), None);
        assert_eq!(proxy_target(&Url::parse("http://[::1]:8000/").unwrap(), &routes, &exclusions), None);
        assert_eq!(proxy_target(&Url::parse("https://api.internal.example/").unwrap(), &routes, &exclusions), None);
        assert_eq!(proxy_target(&Url::parse("https://api.example/").unwrap(), &routes, &exclusions), Some("http://proxy-https.example:8080".into()));
        assert_eq!(proxy_target(&Url::parse("http://api.example/").unwrap(), &routes, &exclusions), Some("http://proxy-http.example:80".into()));
    }
}
