import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";
import type { AiConfig, ChannelModel, ModelChannel } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";
import type { ReferenceImage } from "../src/types/image";

// Keep config persistence and all API calls inside this test process.
const values = new Map<string, string>();
const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
// Zustand reads window.localStorage; omitting window.window keeps FileSaver in its non-DOM mode.
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });

const {
    CONFIG_STORE_KEY, defaultConfig, defaultWebdavSyncConfig, normalizeChannelModels,
    resolveModelImageSizes, supportsModelImageSizes, useConfigStore,
} = await import("../src/stores/use-config-store");
const { normalizeImageSizeOption, normalizeModelImageSizes, parseModelImageSizes, isModelImageSizeSupported } = await import("../src/lib/model-image-sizes");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");
const { requestGeneration, requestEdit } = await import("../src/services/api/image");
const imageStorage = await import("../src/services/image-storage");
const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
const fileSaver = await import("file-saver");
const { exportAppConfig, importAppConfig } = await import("../src/services/config-file");
const { default: axios } = await import("axios");

const initialConfigState = useConfigStore.getState();
const initialPromptState = usePromptSourceStore.getState();
const configStorage = useConfigStore.persist.getOptions().storage;
const promptStorage = usePromptSourceStore.persist.getOptions().storage;
useConfigStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
usePromptSourceStore.persist.setOptions({ storage: createJSONStorage(() => storage) });

afterEach(() => {
    mock.restore();
    useConfigStore.setState(initialConfigState);
    usePromptSourceStore.setState(initialPromptState);
});
afterAll(() => {
    useConfigStore.persist.setOptions({ storage: configStorage });
    usePromptSourceStore.persist.setOptions({ storage: promptStorage });
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

function channel(id: string, imageSizes?: string[], overrides: Partial<ChannelModel> = {}, apiFormat: ModelChannel["apiFormat"] = "openai"): ModelChannel {
    return {
        id, name: id, baseUrl: `https://${id}.example.test`, apiKey: "test-key", apiFormat,
        models: [{ name: "shared-image", capability: "image", imageSizes, ...overrides }],
    };
}

function configFor(channels: ModelChannel[], selected = channels[0].id, size = "1024x1024"): AiConfig {
    return {
        ...defaultConfig, channels, model: `${selected}::shared-image`, imageModel: `${channels[0].id}::shared-image`,
        models: channels.map((item) => `${item.id}::shared-image`), size, count: "1", proxyEnabled: false,
    };
}

const reference: ReferenceImage = { id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" };
const script = 'return await request({ method: "post", url: "/mock-image", data: { model, size: params.size, images } });';

function interceptImages() {
    return {
        post: spyOn(axios, "post").mockResolvedValue({ data: { data: [{ url: "https://result.example.test/image.png" }] } }),
        request: spyOn(axios, "request").mockResolvedValue({ data: ["https://result.example.test/image.png"] }),
        read: spyOn(imageStorage, "imageToDataUrl").mockResolvedValue(reference.dataUrl),
    };
}

function configFile(config: AiConfig) {
    return {
        app: "infinite-canvas", version: 1, exportedAt: "",
        config, webdav: { ...defaultWebdavSyncConfig, directory: "imported" },
        promptSources: { sources: [], schedule: { intervalMinutes: 60, lastFetchedAt: "imported" } },
    };
}

test("size entries normalize separators, omit blank lines and deduplicate without changing order", () => {
    expect(parseModelImageSizes(" 2048×2048 \n\n2368*1776\r\n2048x2048\nauto\n1024X1024\n")).toEqual([
        "2048x2048", "2368x1776", "auto", "1024x1024",
    ]);
    expect(normalizeImageSizeOption(" 1024 × 1024 ")).toBe("1024x1024");
    expect(normalizeModelImageSizes(undefined)).toBeUndefined();
    expect(normalizeModelImageSizes([])).toBeUndefined();
    expect(parseModelImageSizes("\n  \n")).toBeUndefined();
    expect(isModelImageSizeSupported(["1024x1024", "auto"], "auto")).toBe(true);
    expect(isModelImageSizeSupported(["auto"], "  ")).toBe(true);
    expect(isModelImageSizeSupported(["1024x1024"], "1:1")).toBe(false);
});

test("malformed sizes reject the whole list and report the original line number", () => {
    expect(() => parseModelImageSizes("1024x1024\n\n1024x0")).toThrow(/3/);
    expect(() => normalizeModelImageSizes(["1024x1024", "1:1"])).toThrow(/2/);
    expect(() => normalizeModelImageSizes("1024x1024")).toThrow();
    for (const invalid of [null, 1024, "1.5x1024", "-1x1024", "Infinityx1024", "1024x0"]) {
        expect(normalizeImageSizeOption(invalid)).toBeNull();
    }
});

test("lists belong to the selected channel and apply only to image APIs that support them", () => {
    const channels = [
        channel("first", ["1024x1024"]), channel("second", ["2368x1776"]),
        channel("gemini", ["4096x4096"], {}, "gemini"),
        channel("scripted-gemini", ["4096x4096"], { script }, "gemini"),
        channel("video", ["4096x4096"], { capability: "video", script }),
    ];
    const config = configFor(channels);
    expect(resolveModelImageSizes(config, "first::shared-image")).toEqual(["1024x1024"]);
    expect(resolveModelImageSizes(config, "second::shared-image")).toEqual(["2368x1776"]);
    expect(resolveModelImageSizes(config, "missing::shared-image")).toBeUndefined();
    expect(resolveModelImageSizes(config, "gemini::shared-image")).toBeUndefined();
    expect(resolveModelImageSizes(config, "scripted-gemini::shared-image")).toEqual(["4096x4096"]);
    expect(resolveModelImageSizes(config, "video::shared-image")).toBeUndefined();
    expect(supportsModelImageSizes(channels[2], channels[2].models[0])).toBe(false);
    expect(supportsModelImageSizes(channels[3], channels[3].models[0])).toBe(true);
});

test("canvas generation and retries retain the node model and unsupported saved size", () => {
    const config = configFor([channel("default", ["1024x1024"]), channel("node", ["2368x1776"])]);
    const node: CanvasNodeData = {
        id: "saved-image", type: CanvasNodeType.Image, title: "Saved image", position: { x: 0, y: 0 }, width: 320, height: 240,
        metadata: { model: "node::shared-image", size: "2048x2048" },
    };
    const selected = buildGenerationConfig(config, node, "image");
    expect(selected.model).toBe("node::shared-image");
    expect(selected.size).toBe("2048x2048");
    expect(resolveModelImageSizes(selected, selected.model)).toEqual(["2368x1776"]);
    expect(isModelImageSizeSupported(resolveModelImageSizes(selected, selected.model)!, selected.size)).toBe(false);
    expect(resolveModelImageSizes(config, config.imageModel)).toEqual(["1024x1024"]);
});

test("saving channels and rehydrating config preserve model sizes and the current selection", async () => {
    const normalized = normalizeChannelModels([{ name: "shared-image", capability: "image", imageSizes: ["2368×1776", "auto", "2368*1776"], script: " return []; " }]);
    const config = configFor([{ ...channel("saved"), models: normalized }], "saved", "1024x1024");
    useConfigStore.setState({ config });
    useConfigStore.getState().updateConfig("channels", config.channels);
    const persisted = storage.getItem(CONFIG_STORE_KEY)!;
    expect(JSON.parse(persisted).state.config.channels[0].models[0].imageSizes).toEqual(["2368x1776", "auto"]);
    useConfigStore.setState({ config: defaultConfig });
    storage.setItem(CONFIG_STORE_KEY, persisted);
    await useConfigStore.persist.rehydrate();
    const reloaded = useConfigStore.getState().config;
    expect(reloaded.channels[0].models[0]).toEqual({ name: "shared-image", capability: "image", imageSizes: ["2368x1776", "auto"], script: "return [];" });
    expect(reloaded.model).toBe("saved::shared-image");
    expect(reloaded.size).toBe("1024x1024");
});

test("exported model sizes survive import and imported separators are normalized", async () => {
    const config = configFor([channel("exported", ["2368x1776", "auto"])]);
    useConfigStore.setState({ config });
    const save = spyOn(fileSaver, "saveAs").mockImplementation(() => {});
    exportAppConfig();
    const blob = save.mock.calls[0][0] as Blob;
    const exported = JSON.parse(await blob.text());
    expect(exported.config.channels[0].models[0].imageSizes).toEqual(["2368x1776", "auto"]);
    exported.config.channels[0].models[0].imageSizes.push("1024*1024");
    useConfigStore.setState({ config: defaultConfig });
    await importAppConfig(new File([JSON.stringify(exported)], "config.json"));
    expect(useConfigStore.getState().config.channels[0].models[0].imageSizes).toEqual(["2368x1776", "auto", "1024x1024"]);
});

test("an invalid imported size cannot partially replace config, WebDAV or prompt sources", async () => {
    const beforeConfig = useConfigStore.getState().config;
    const beforeWebdav = useConfigStore.getState().webdav;
    const beforePrompts = usePromptSourceStore.getState();
    const valid = channel("valid", ["2368x1776"]);
    const invalid = channel("invalid", ["1024x1024", "0x100"]);
    const channelsWithInvalidSizes = [
        [valid, invalid],
        [{ ...valid, models: [...valid.models, invalid.models[0]] }],
        [{ ...valid, models: [...valid.models, { ...invalid.models[0], name: " " }] }],
    ];
    for (const channels of channelsWithInvalidSizes) {
        const file = new File([JSON.stringify(configFile(configFor(channels)))], "invalid.json");
        await expect(importAppConfig(file)).rejects.toThrow(/2/);
        expect(useConfigStore.getState().config).toBe(beforeConfig);
        expect(useConfigStore.getState().webdav).toBe(beforeWebdav);
        expect(usePromptSourceStore.getState().sources).toBe(beforePrompts.sources);
        expect(usePromptSourceStore.getState().schedule).toBe(beforePrompts.schedule);
    }
});

test("listed dimensions bypass legacy edge, alignment, ratio and pixel limits in actual scripts", async () => {
    const { request, post } = interceptImages();
    const sizes = ["4096x4096", "1025x1025", "4096x512", "256x256"];
    for (const size of sizes) {
        const config = configFor([channel("scripted", sizes, { script })], "scripted", size);
        await requestGeneration(config, "generate");
        expect(request.mock.calls.at(-1)?.[0].data).toEqual({ model: "shared-image", size, images: [] });
        await requestEdit(config, "edit", [reference]);
        expect(request.mock.calls.at(-1)?.[0].data).toEqual({ model: "shared-image", size, images: [reference.dataUrl] });
    }
    expect(post).not.toHaveBeenCalled();
});

test("unlisted sizes fail before reference reads, native HTTP or custom script execution", async () => {
    const { request, post, read } = interceptImages();
    for (const modelScript of [undefined, script]) {
        const config = configFor([channel("strict", ["2368x1776"], { script: modelScript })], "strict", "1024x1024");
        await expect(requestGeneration(config, "generate")).rejects.toThrow();
        await expect(requestEdit(config, "edit", [reference])).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
});

test("native generation and editing use the selected channel before removing its prefix", async () => {
    const { post } = interceptImages();
    const config = configFor([channel("first", ["1024x1024"]), channel("second", ["4096x4096"])], "second", "4096x4096");
    await requestGeneration(config, "generate");
    expect(post.mock.calls[0][0]).toBe("https://second.example.test/v1/images/generations");
    expect(post.mock.calls[0][1]).toMatchObject({ model: "shared-image", size: "4096x4096" });
    await requestEdit(config, "edit", [reference]);
    expect(post.mock.calls[1][0]).toBe("https://second.example.test/v1/images/edits");
    const form = post.mock.calls[1][1] as FormData;
    expect(form.get("model")).toBe("shared-image");
    expect(form.get("size")).toBe("4096x4096");
});

test("auto is omitted from native requests and passed as undefined to scripts only when listed", async () => {
    const { post, request } = interceptImages();
    for (const modelScript of [undefined, script]) {
        const config = configFor([channel("auto", ["auto"], { script: modelScript })], "auto", "auto");
        await requestGeneration(config, "generate");
        await requestEdit(config, "edit", [reference]);
    }
    expect(post.mock.calls[0][1]).not.toHaveProperty("size");
    expect((post.mock.calls[1][1] as FormData).has("size")).toBe(false);
    expect(request.mock.calls[0][0].data.size).toBeUndefined();
    expect(request.mock.calls[1][0].data.size).toBeUndefined();
    const strict = configFor([channel("strict", ["1024x1024"])], "strict", "auto");
    await expect(requestGeneration(strict, "generate")).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(2);
});

test("without a custom list the existing generation and editing size limits still apply", async () => {
    const { post, request } = interceptImages();
    for (const modelScript of [undefined, script]) {
        for (const size of ["4096x4096", "1025x1025", "4096x512", "256x256"]) {
            const config = configFor([channel("generic", undefined, { script: modelScript })], "generic", size);
            await expect(requestGeneration(config, "generate")).rejects.toThrow();
            await expect(requestEdit(config, "edit", [reference])).rejects.toThrow();
        }
    }
    expect(post).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await requestGeneration(configFor([channel("generic")], "generic", "1:1"), "generate");
    expect(post.mock.calls[0][1]).toMatchObject({ size: "1024x1024" });
});

test("native Gemini keeps its size controls while Gemini custom scripts enforce model sizes", async () => {
    const { post, request } = interceptImages();
    post.mockResolvedValue({ data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }] } });
    const native = configFor([channel("gemini", ["4096x4096"], {}, "gemini")]);
    await requestGeneration(native, "generate");
    await requestEdit(native, "edit", [reference]);
    expect(post.mock.calls[0][1]).toMatchObject({ generationConfig: { imageConfig: { aspectRatio: "1:1", imageSize: "1K" } } });
    const scripted = configFor([channel("gemini", ["4096x4096"], { script }, "gemini")], "gemini", "4096x4096");
    await requestGeneration(scripted, "generate");
    expect(request.mock.calls[0][0].data.size).toBe("4096x4096");
    await expect(requestEdit({ ...scripted, size: "1024x1024" }, "edit", [reference])).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
});
