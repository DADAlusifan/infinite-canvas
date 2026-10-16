import { expect, spyOn, test } from "bun:test";
import * as desktop from "../src/services/desktop/runtime";
import * as media from "../src/services/file-storage";
import { encodeStoredValue, inspectStoredValue } from "../src/services/storage/codec";
import { flushStorage } from "../src/services/storage/maintenance";

type RecordValue = { namespace: string; key: string; value: string };
const canvasKey = "infinite-canvas:canvas_store";
const assetKey = "infinite-canvas:asset_store";
let instance = 0;

async function stored(key: string, state: unknown): Promise<RecordValue> {
    return { namespace: "app_state", key, value: await encodeStoredValue(JSON.stringify({ state, version: 0 }), async () => { throw new Error("unexpected binary write"); }) };
}

async function nativeFixture(records: RecordValue[], run: (commands: string[], values: Map<string, RecordValue>) => Promise<void>) {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
    const commands: string[] = [];
    const values = new Map(records.map((record) => [`${record.namespace}/${record.key}`, { ...record }]));
    const detection = spyOn(desktop, "isDesktop").mockReturnValue(true);
    const invoke = spyOn(desktop, "desktopInvoke").mockImplementation(async (command, args) => {
        commands.push(command);
        if (command === "desktop_records_get") return (values.get(`${args?.namespace}/${args?.key}`)?.value ?? null) as any;
        if (command === "desktop_records_list") return [...values.values()].filter((record) => !args?.namespace || record.namespace === args.namespace) as any;
        if (command === "desktop_records_batch") {
            for (const mutation of args?.mutations as any[]) {
                if (mutation.op !== "set") throw new Error("unexpected destructive write");
                values.set(`${mutation.namespace}/${mutation.key}`, { namespace: mutation.namespace, key: mutation.key, value: mutation.value });
            }
        }
        return undefined as any;
    });
    try { await run(commands, values); }
    finally {
        invoke.mockRestore(); detection.mockRestore();
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
}

async function canvasStore() {
    return (await import(`../src/stores/canvas/use-canvas-store.ts?hydration=${instance++}`) as typeof import("../src/stores/canvas/use-canvas-store")).useCanvasStore;
}
async function assetStore() {
    return (await import(`../src/stores/use-asset-store.ts?hydration=${instance++}`) as typeof import("../src/stores/use-asset-store")).useAssetStore;
}

test("failed JSON, state shape or codec hydration never writes default canvas or assets", async () => {
    for (const key of [canvasKey, assetKey]) {
        const invalidValues = [
            "invalid codec JSON",
            await encodeStoredValue("invalid state JSON", async () => { throw new Error("binary"); }),
            await encodeStoredValue(JSON.stringify({ state: {}, version: 0 }), async () => { throw new Error("binary"); }),
        ];
        for (const value of invalidValues) {
            await nativeFixture([{ namespace: "app_state", key, value }], async (commands, records) => {
                const store = key === canvasKey ? await canvasStore() : await assetStore();
                expect(commands).toEqual([]); // Desktop creation must not start implicit hydration.
                await store.persist.rehydrate();
                await flushStorage();
                expect(store.persist.hasHydrated()).toBe(false);
                expect(store.getState().hydrated).toBe(false);
                expect(commands).not.toContain("desktop_records_batch");
                expect(records.get(`app_state/${key}`)?.value).toBe(value);
            });
        }
    }
});

test("media restoration failure leaves the original asset record untouched", async () => {
    const original = await stored(assetKey, { assets: [{ id: "video", kind: "video", data: { storageKey: "video:kept", url: "" } }] });
    await nativeFixture([original], async (commands, records) => {
        const restoreMedia = spyOn(media, "resolveMediaUrl").mockRejectedValue(new Error("media read failed"));
        try {
            const store = await assetStore();
            await store.persist.rehydrate();
            await flushStorage();
            expect(store.persist.hasHydrated()).toBe(false);
            expect(store.getState().hydrated).toBe(false);
            expect(commands).not.toContain("desktop_records_batch");
            expect(records.get(`app_state/${assetKey}`)?.value).toBe(original.value);
        } finally { restoreMedia.mockRestore(); }
    });
});

test("valid desktop hydration retains identities without rewriting records, and a new empty store is valid", async () => {
    const project = { id: "kept-project", nodes: [], connections: [], viewport: { x: 3, y: 4, k: 1 } };
    const asset = { id: "kept-asset", kind: "text", data: { content: "original text" } };
    const original = [await stored(canvasKey, { projects: [project], deletedProjects: [] }), await stored(assetKey, { assets: [asset] })];
    await nativeFixture(original, async (commands, records) => {
        const canvas = await canvasStore();
        const assets = await assetStore();
        await Promise.all([canvas.persist.rehydrate(), assets.persist.rehydrate()]);
        await flushStorage();
        expect(canvas.persist.hasHydrated()).toBe(true);
        expect(assets.persist.hasHydrated()).toBe(true);
        expect(canvas.getState().projects[0]).toEqual(project);
        expect(assets.getState().assets[0]).toEqual(asset);
        expect(commands).not.toContain("desktop_records_batch");
        for (const record of original) expect(records.get(`${record.namespace}/${record.key}`)?.value).toBe(record.value);
        expect(JSON.parse(inspectStoredValue(records.get(`app_state/${canvasKey}`)!.value).value as string).state.projects[0].id).toBe("kept-project");
    });
    await nativeFixture([], async (commands) => {
        const canvas = await canvasStore();
        const assets = await assetStore();
        await Promise.all([canvas.persist.rehydrate(), assets.persist.rehydrate()]);
        await flushStorage();
        expect(canvas.getState().hydrated).toBe(true);
        expect(assets.getState().hydrated).toBe(true);
        expect(commands).not.toContain("desktop_records_batch");
    });
});

test("startup rejects corrupt preferences, unknown persisted versions and codecs before mounting UI", async () => {
    const { mountApplication, validateDesktopPersistence } = await import("../src/app-bootstrap");
    for (const record of [
        { namespace: "preferences", key: "infinite-canvas:theme_store", value: "invalid JSON" },
        { namespace: "preferences", key: "infinite-canvas:ai_config_store", value: JSON.stringify({ state: {}, version: 0 }) },
        { namespace: "preferences", key: "infinite-canvas:theme_store", value: JSON.stringify({ state: { theme: "dark" }, version: 99 }) },
        { namespace: "plugin:test", key: "data", value: "unknown codec" },
    ]) {
        await nativeFixture([record], async (commands, records) => {
            await expect(mountApplication()).rejects.toThrow();
            expect(commands).toEqual(["desktop_records_list"]);
            expect(records.get(`${record.namespace}/${record.key}`)?.value).toBe(record.value);
        });
    }
    await nativeFixture([], async (commands) => {
        await validateDesktopPersistence();
        expect(commands).toEqual(["desktop_records_list"]);
    });
});
