import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as runtime from "../src/services/desktop/runtime";
import { createDesktopSaveTarget, saveFile } from "../src/services/desktop/files";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
    mock.restore();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
});

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}

let instance = 0;
async function nativeRuntime() {
    const apiBase = "http://127.0.0.1:43210/test-session";
    const commands: string[] = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        __TAURI_INTERNALS__: { invoke: async (command: string) => {
            commands.push(command);
            if (command !== "desktop_runtime") throw new Error(`Unexpected native command: ${command}`);
            return { dataRoot: "D:\\CanvasData", apiBase, network: { mode: "direct", url: "" }, networkError: null };
        } },
    } });
    Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "http://tauri.localhost/canvas/example", origin: "http://tauri.localhost" } });
    // Keep runtime initialization isolated from other suites without a production reset API.
    const service = await import(`../src/services/desktop/runtime.ts?runtime-test=${instance++}`) as typeof runtime;
    await service.initializeDesktop();
    return { service, apiBase, commands };
}

test("desktop runtime preserves signed URLs and excludes application, blob and already proxied resources", async () => {
    const { service, apiBase, commands } = await nativeRuntime();
    const signed = "https://media.example.test/video%2Fone.mp4?signature=a%2Bb%3D&name=%E5%9B%BE+1";
    expect(service.desktopProxyUrl(signed)).toBe(`${apiBase}/proxy/${encodeURIComponent(signed)}`);
    expect(decodeURIComponent(service.desktopProxyUrl(signed).slice(`${apiBase}/proxy/`.length))).toBe(signed);
    for (const value of [`${apiBase}/blob/media_files/video%3Aone`, "http://tauri.localhost/plugins/index.json", "http://asset.localhost/image.png", "blob:http://tauri.localhost/id", "data:image/png;base64,AA=="]) {
        expect(service.desktopProxyUrl(value)).toBe(value);
    }
    expect(service.desktopBlobUrl("plugin-binary", "name/中文:one")).toBe(`${apiBase}/blob/plugin-binary/${encodeURIComponent("name/中文:one")}`);
    expect(commands).toEqual(["desktop_runtime"]);
});

test("HTTP failures are not saved as successful video or audio files", async () => {
    await nativeRuntime();
    const { uploadMediaFile } = await import("../src/services/file-storage");
    for (const status of [404, 502]) {
        const response = new Response("provider error", { status });
        const body = spyOn(response, "blob");
        const request = spyOn(globalThis, "fetch").mockResolvedValue(response);
        await expect(uploadMediaFile("https://media.example.test/result.mp4", "video")).rejects.toThrow(String(status));
        expect(request).toHaveBeenCalledTimes(1);
        expect(body).not.toHaveBeenCalled();
        request.mockRestore();
    }
});

test("desktop model requests preserve JSON and FormData body sources for HTTP/1 uploads", async () => {
    const { service, apiBase } = await nativeRuntime();
    const controller = new AbortController();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        calls.push({ input, init });
        return new Response("ok");
    });
    const json = JSON.stringify({ prompt: "测试", size: "2048x2048" });
    const headers = { Authorization: "Bearer test-only", "Content-Type": "application/json" };
    await service.desktopFetch("https://api.example.test/images", { method: "POST", headers, body: json, signal: controller.signal });
    const form = new FormData();
    form.append("image", new File([new Uint8Array([0, 255, 7])], "图.png", { type: "image/png" }));
    form.append("prompt", "保留边界");
    await service.desktopFetch(new URL("https://api.example.test/edits"), { method: "POST", body: form });
    expect(calls[0].input).toBe(`${apiBase}/proxy/${encodeURIComponent("https://api.example.test/images")}`);
    expect(calls[0].init?.body).toBe(json);
    expect(calls[0].init?.headers).toBe(headers);
    expect(calls[0].init?.signal).toBe(controller.signal);
    expect(calls[1].init?.body).toBe(form);
    expect(calls[1].init?.headers).toBeUndefined();
    await service.desktopFetch("/plugins/index.json");
    expect(calls[2].input).toBe("http://tauri.localhost/plugins/index.json");
});

test("the Request overload preserves bytes, request options and cancellation when remapping its origin", async () => {
    const { service } = await nativeRuntime();
    const controller = new AbortController();
    let captured: RequestInit | undefined;
    spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => { captured = init; return new Response("ok"); });
    const input = new Request("https://api.example.test/upload", {
        method: "PUT", body: new Uint8Array([0, 1, 255]), headers: { "Content-Type": "application/octet-stream", "X-Model": "custom" },
        signal: controller.signal, redirect: "error", credentials: "omit",
    });
    await service.desktopFetch(input, { method: "POST" });
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await (captured?.body as Blob).arrayBuffer())]).toEqual([0, 1, 255]);
    expect(new Headers(captured?.headers).get("X-Model")).toBe("custom");
    expect(captured?.redirect).toBe("error");
    expect(captured?.credentials).toBe(input.credentials);
    controller.abort();
    expect(captured?.signal?.aborted).toBe(true);
});

test("an already canceled Request does not consume its body or contact the native proxy", async () => {
    const { service } = await nativeRuntime();
    let consumed = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { consumed = true; controller.enqueue(new Uint8Array([1])); controller.close(); } }, { highWaterMark: 0 });
    const controller = new AbortController();
    controller.abort(new DOMException("Canceled before upload", "AbortError"));
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        init?.signal?.throwIfAborted();
        return new Response("ok");
    });
    const request = new Request("https://api.example.test/upload", { method: "POST", body, signal: controller.signal, duplex: "half" } as RequestInit);
    await expect(service.desktopFetch(request)).rejects.toThrow("Canceled before upload");
    expect(consumed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
});

test("canceling an explicit Request interrupts a blocked body read before native upload", async () => {
    const { service } = await nativeRuntime();
    const started = deferred();
    const release = deferred();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) { started.resolve(); await release.promise; if (!canceled) controller.close(); },
        cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        init?.signal?.throwIfAborted();
        return new Response("ok");
    });
    const request = new Request("https://api.example.test/upload", { method: "POST", body, signal: controller.signal, duplex: "half" } as RequestInit);
    const result = service.desktopFetch(request).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    await started.promise;
    controller.abort(new DOMException("Canceled while reading", "AbortError"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const outcome = await Promise.race([result, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 150); })]);
        expect(outcome).not.toBeNull();
        expect(outcome?.ok).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    } finally { if (timer) clearTimeout(timer); release.resolve(); await result; }
});

function saveHarness() {
    const commands: string[] = [];
    spyOn(runtime, "isDesktop").mockReturnValue(true);
    spyOn(runtime, "desktopInvoke").mockImplementation(async (command) => {
        commands.push(command);
        return (command === "desktop_save_begin" ? { id: "save-ticket", uploadUrl: "http://127.0.0.1:43210/session/save/save-ticket" } : undefined) as any;
    });
    return commands;
}

test("desktop saving sends ordered binary chunks with offsets and commits only after all writes finish", async () => {
    const commands = saveHarness();
    const gate = deferred();
    const firstStarted = deferred();
    const calls: Array<{ offset: string | null; bytes: number[] }> = [];
    spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        expect(init?.body).toBeInstanceOf(Blob);
        calls.push({ offset: new Headers(init?.headers).get("x-desktop-offset"), bytes: [...new Uint8Array(await (init?.body as Blob).arrayBuffer())] });
        if (calls.length === 1) { firstStarted.resolve(); await gate.promise; }
        return new Response(null, { status: 204 });
    });
    const target = (await createDesktopSaveTarget("output.zip"))!;
    const writer = target.writable.getWriter();
    const first = writer.write(new Uint8Array([0, 255, 1]));
    const second = writer.write(new Uint8Array([2, 3]));
    await firstStarted.promise;
    expect(calls).toHaveLength(1);
    expect(commands).toEqual(["desktop_save_begin"]);
    gate.resolve();
    await Promise.all([first, second]);
    writer.releaseLock();
    expect(calls).toEqual([{ offset: "0", bytes: [0, 255, 1] }, { offset: "3", bytes: [2, 3] }]);
    expect(commands).toEqual(["desktop_save_begin"]);
    await target.commit();
    expect(commands).toEqual(["desktop_save_begin", "desktop_save_finish"]);
});

test("a failed desktop file write cancels its native ticket without committing over the old file", async () => {
    const commands = saveHarness();
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("disk full", { status: 507 }));
    await expect(saveFile(new Blob(["replacement bytes"]), "existing.txt")).rejects.toThrow();
    expect(commands).toEqual(["desktop_save_begin", "desktop_save_cancel"]);
});

test("canceling a desktop save aborts its pending PUT and discards the native ticket", async () => {
    const commands = saveHarness();
    const started = deferred();
    spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        started.resolve();
    }));
    const target = (await createDesktopSaveTarget("cancel.zip"))!;
    const writer = target.writable.getWriter();
    const writing = writer.write(new Uint8Array([1])).then(() => null, (error: unknown) => error);
    await started.promise;
    const reason = new DOMException("User canceled save", "AbortError");
    await target.abort(reason);
    expect(await writing).toBe(reason);
    writer.releaseLock();
    expect(commands).toEqual(["desktop_save_begin", "desktop_save_cancel"]);
});

test("configuration import commits both real preference-backed stores once and preserves them on native transaction failure", async () => {
    const { createJSONStorage } = await import("zustand/middleware");
    const { preferences, initializePreferences } = await import("../src/services/storage/preferences");
    const { useConfigStore, defaultConfig, defaultWebdavSyncConfig } = await import("../src/stores/use-config-store");
    const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
    const { importAppConfig } = await import("../src/services/config-file");
    const configBefore = useConfigStore.getState();
    const promptsBefore = usePromptSourceStore.getState();
    const configOptions = useConfigStore.persist.getOptions();
    const promptOptions = usePromptSourceStore.persist.getOptions();
    const database = new Map<string, string>([
        [configOptions.name, JSON.stringify({ state: { config: defaultConfig, webdav: defaultWebdavSyncConfig }, version: 0 })],
        [promptOptions.name, JSON.stringify({ state: { sources: promptsBefore.sources, schedule: promptsBefore.schedule }, version: 0 })],
    ]);
    let failTransaction = false;
    let configurationTransactions = 0;
    spyOn(runtime, "isDesktop").mockReturnValue(true);
    spyOn(runtime, "desktopInvoke").mockImplementation(async (command, args) => {
        if (command === "desktop_records_list") return [...database].map(([key, value]) => ({ namespace: "preferences", key, value })) as any;
        if (command === "desktop_maintenance_begin") return { token: "configuration-lease" } as any;
        if (command === "desktop_records_batch") {
            const mutations = args?.mutations as Array<{ op: string; namespace: string; key: string; value: string }>;
            const changed = mutations.filter((entry) => entry.namespace === "preferences");
            if (changed.length) {
                configurationTransactions++;
                if (failTransaction) throw new Error("native transaction failed");
                expect(args?.lease).toBe("configuration-lease");
                expect(changed.map((entry) => entry.key).sort()).toEqual([configOptions.name, promptOptions.name].sort());
                for (const entry of changed) database.set(entry.key, entry.value);
            }
            return 1 as any;
        }
        if (command === "desktop_storage_flush" || command === "desktop_maintenance_end") return undefined as any;
        throw new Error(`Unexpected native command: ${command}`);
    });
    const actualPreferences = createJSONStorage(() => preferences);
    useConfigStore.persist.setOptions({ storage: actualPreferences });
    usePromptSourceStore.persist.setOptions({ storage: actualPreferences });
    const noopStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    try {
        await initializePreferences();
        await useConfigStore.persist.rehydrate();
        await usePromptSourceStore.persist.rehydrate();
        const config = {
            ...defaultConfig,
            channels: [{ id: "native-import", name: "模型", baseUrl: "https://api.example.test", apiKey: "test-only", apiFormat: "openai", models: [{ name: "custom-image", capability: "image", imageSizes: ["4096x4096"] }] }],
            imageModel: "native-import::custom-image",
        };
        const promptSources = {
            sources: [{ id: "custom", name: "提示词", url: "https://example.test/prompts.json", homepage: "https://example.test", enabled: true, builtIn: false }],
            schedule: { intervalMinutes: 30, lastFetchedAt: "" },
        };
        const payload = { app: "infinite-canvas", version: 1, exportedAt: "", config, webdav: defaultWebdavSyncConfig, promptSources };
        await importAppConfig(new File([JSON.stringify(payload)], "config.json"));
        expect(configurationTransactions).toBe(1);
        expect(useConfigStore.getState().config.channels[0].models[0]).toMatchObject({ name: "custom-image", imageSizes: ["4096x4096"] });
        expect(usePromptSourceStore.getState().sources).toEqual(promptSources.sources);
        expect(preferences.getItem(configOptions.name)).toBe(database.get(configOptions.name)!);
        expect(preferences.getItem(promptOptions.name)).toBe(database.get(promptOptions.name)!);
        const afterSuccess = [...database];
        const configured = useConfigStore.getState().config;
        const sources = usePromptSourceStore.getState().sources;
        failTransaction = true;
        const next = { ...payload, config: { ...config, imageModel: "would-partially-replace" }, promptSources: { ...promptSources, sources: [] } };
        await expect(importAppConfig(new File([JSON.stringify(next)], "config.json"))).rejects.toThrow("native transaction failed");
        expect([...database]).toEqual(afterSuccess);
        expect(useConfigStore.getState().config).toBe(configured);
        expect(usePromptSourceStore.getState().sources).toBe(sources);
        expect(preferences.getItem(configOptions.name)).toBe(database.get(configOptions.name)!);
        expect(preferences.getItem(promptOptions.name)).toBe(database.get(promptOptions.name)!);
    } finally {
        // Restore live stores without enqueueing persistence into another test's environment.
        useConfigStore.persist.setOptions({ storage: noopStorage });
        usePromptSourceStore.persist.setOptions({ storage: noopStorage });
        useConfigStore.setState(configBefore, true);
        usePromptSourceStore.setState(promptsBefore, true);
        useConfigStore.persist.setOptions({ storage: configOptions.storage });
        usePromptSourceStore.persist.setOptions({ storage: promptOptions.storage });
    }
});

test("rejected values and invalid replacement batches never poison later storage flushes", async () => {
    const { createStorage } = await import("../src/services/storage/driver");
    const { flushStorage, withStorageMaintenance } = await import("../src/services/storage/maintenance");
    const commands: string[] = [];
    const writes: Array<{ namespace: string; key: string }> = [];
    spyOn(runtime, "isDesktop").mockReturnValue(true);
    spyOn(runtime, "desktopInvoke").mockImplementation(async (command, args) => {
        commands.push(command);
        if (command === "desktop_records_batch") writes.push(...args?.mutations as typeof writes);
        if (command === "desktop_maintenance_begin") return { token: "after-rejection" } as any;
        return 1 as any;
    });
    const network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("invalid input must not write binary files"); });
    const store = createStorage("plugin:rejected-values");
    await expect(store.setItem("invalid", { callback: () => 1 })).rejects.toThrow("函数");
    await expect(store.replace([
        ["first", { binary: new Blob(["must not upload"]) }],
        ["second", { callback: () => 1 }],
    ])).rejects.toThrow("函数");
    await expect(store.setItem(undefined as unknown as string, { valid: true })).rejects.toThrow("存储键");
    await expect(createStorage("image_files").setItem("image:invalid", "not a blob")).rejects.toThrow("媒体存储");
    expect(writes).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    spyOn(runtime, "desktopBlobUrl").mockReturnValue("http://127.0.0.1:43210/test/blob/image_files/existing");
    network.mockResolvedValue(new Response("media conflict", { status: 409 }));
    await expect(createStorage("image_files").setItem("image:existing", new Blob(["different bytes"]))).rejects.toThrow("拒绝覆盖");
    await store.setItem("valid", { text: "正常记录" });
    await flushStorage();
    await flushStorage();
    await withStorageMaintenance("backup after rejected input", async () => undefined);
    expect(writes.map((write) => write.key)).toEqual(["valid"]);
    expect(commands.filter((command) => command === "desktop_storage_flush")).toHaveLength(3);
    expect(commands.at(-1)).toBe("desktop_maintenance_end");
});

test("the installed Tauri SDK can complete its close-to-destroy flow with the application capabilities", async () => {
    const capability = await Bun.file(new URL("../src-tauri/capabilities/main.json", import.meta.url)).json();
    const permissions = new Set<string>(capability.permissions);
    let listener: ((event: unknown) => Promise<void>) | undefined;
    const callbacks = new Map<number, (event: unknown) => Promise<void>>();
    const calls: string[] = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
        __TAURI_INTERNALS__: {
            metadata: { currentWindow: { label: "main" } },
            transformCallback(callback: (event: unknown) => Promise<void>) { callbacks.set(1, callback); return 1; },
            async invoke(command: string, args: { handler?: number }) {
                if (command === "plugin:event|listen") { listener = callbacks.get(args.handler!); return 1; }
                if (command === "plugin:event|unlisten") return;
                const action = command.split("|")[1];
                if (!permissions.has(`core:window:allow-${action}`)) throw new Error(`window permission denied: ${action}`);
                calls.push(action);
                if (action === "close") await listener!({ event: "tauri://close-requested", id: 1, payload: null });
            },
        },
    } });
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    const save = deferred();
    let saved = false;
    const unlisten = await window.onCloseRequested(async (event) => {
        if (saved) return;
        event.preventDefault();
        await save.promise;
        saved = true;
        await window.close();
    });
    try {
        const closing = window.close();
        await Promise.resolve();
        expect(calls).toEqual(["close"]);
        save.resolve();
        await closing;
        expect(calls).toEqual(["close", "close", "destroy"]);
    } finally { await unlisten(); }
});
