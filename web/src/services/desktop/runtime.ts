export type DesktopNetwork = { mode: "system" | "direct" | "manual"; url: string };
export type DesktopRuntime = { dataRoot: string; apiBase: string; network: DesktopNetwork; networkError: string | null };

let runtime: DesktopRuntime | null = null;

export function isDesktop() {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getDesktopRuntime() {
    return runtime;
}

export async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!isDesktop()) throw new Error("此操作仅在桌面版中可用");
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
}

export async function initializeDesktop() {
    runtime = isDesktop() ? await desktopInvoke<DesktopRuntime>("desktop_runtime") : null;
}

export async function updateDesktopNetwork(network: DesktopNetwork) {
    const result = await desktopInvoke<DesktopNetwork>("desktop_network_set", { network });
    if (runtime) runtime = { ...runtime, network: result, networkError: null };
    return result;
}

export function desktopBlobUrl(namespace: string, key: string) {
    if (!runtime) throw new Error("桌面存储尚未初始化");
    return `${runtime.apiBase}/blob/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
}

export function desktopProxyUrl(value: string) {
    if (!runtime || !/^https?:\/\//i.test(value)) return value;
    const url = new URL(value);
    if (value.startsWith(`${runtime.apiBase}/`) || ["tauri.localhost", "asset.localhost"].includes(url.hostname)) return value;
    if (typeof location !== "undefined" && url.origin === location.origin) return value;
    return `${runtime.apiBase}/proxy/${encodeURIComponent(value)}`;
}

export async function desktopFetch(input: RequestInfo | URL, init?: RequestInit) {
    if (!(input instanceof Request)) {
        const url = new URL(String(input), typeof location !== "undefined" ? location.href : undefined).href;
        return fetch(desktopProxyUrl(url), init);
    }
    (init?.signal || input.signal).throwIfAborted();
    const original = new Request(input, init);
    original.signal.throwIfAborted();
    const target = desktopProxyUrl(original.url);
    if (target === original.url) return fetch(original);
    // A Request exposes its body as a stream. Materialize only this explicit
    // Request overload; normal Blob/FormData callers retain their original body.
    // Chromium cannot send a duplex request stream to the local HTTP/1 server.
    const body = original.body ? await new Response(original.body.pipeThrough(new TransformStream(), { signal: original.signal }), { headers: original.headers }).blob() : undefined;
    return fetch(target, { method: original.method, headers: original.headers, body, signal: original.signal, cache: original.cache, credentials: original.credentials, mode: original.mode, redirect: original.redirect, referrerPolicy: original.referrerPolicy, integrity: original.integrity, keepalive: original.keepalive });
}
