import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as desktop from "../src/services/desktop/runtime";
import * as driver from "../src/services/storage/driver";
import { encodeStoredValue } from "../src/services/storage/codec";
import { currentMediaReferences, registerMediaReferences } from "../src/services/storage/references";

afterEach(() => mock.restore());

let moduleId = 0;
async function maintenance(native = false) {
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    spyOn(desktop, "isDesktop").mockReturnValue(native);
    spyOn(desktop, "desktopInvoke").mockImplementation(async (command, args) => {
        commands.push({ command, args });
        return (command === "desktop_maintenance_begin" ? { token: "test-lease" } : undefined) as any;
    });
    // Each test owns a fresh queue and error journal. No production reset API is
    // needed, and these mocks never load a real browser or native data directory.
    const service = await import(`../src/services/storage/maintenance.ts?case=${moduleId++}`) as typeof import("../src/services/storage/maintenance");
    return { service, commands };
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test("generation and sync activity prevent maintenance until every operation finishes", async () => {
    const { service, commands } = await maintenance(true);
    const finishGeneration = service.startStorageActivity();
    const finishSync = service.startStorageActivity();
    let started = false;
    await expect(service.withStorageMaintenance("backup", async () => { started = true; })).rejects.toThrow("等待生成");
    expect(service.getMaintenanceState().activities).toBe(2);
    finishGeneration();
    await expect(service.withStorageMaintenance("cleanup", async () => undefined)).rejects.toThrow("等待生成");
    finishSync();
    await service.withStorageMaintenance("backup", async () => { started = true; });
    expect(started).toBe(true);
    expect(service.getMaintenanceState()).toMatchObject({ busy: false, activities: 0 });
    expect(commands.map(({ command }) => command)).toEqual(["desktop_storage_flush", "desktop_maintenance_begin", "desktop_maintenance_end"]);
    await expect(service.withStorageActivity(async () => { throw new Error("generation failed"); })).rejects.toThrow("generation failed");
    expect(service.getMaintenanceState().activities).toBe(0);
    let externalAgentBusy = true;
    const unregister = service.registerMaintenanceBlocker(() => externalAgentBusy);
    await expect(service.withStorageMaintenance("backup", async () => undefined)).rejects.toThrow("对话");
    externalAgentBusy = false;
    await service.withStorageMaintenance("backup", async () => undefined);
    unregister();
});

test("writes preserve enqueue order even when an older write is slower", async () => {
    const { service } = await maintenance();
    const gate = deferred();
    const started = deferred();
    const calls: string[] = [];
    let persisted = "";
    const first = service.queueStorageWrite(async () => {
        calls.push("first:start");
        started.resolve();
        await gate.promise;
        persisted = "old";
        calls.push("first:done");
    });
    const second = service.queueStorageWrite(async () => { persisted = "new"; calls.push("second"); });
    await started.promise;
    expect(calls).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    await service.flushStorage();
    expect(calls).toEqual(["first:start", "first:done", "second"]);
    expect(persisted).toBe("new");
});

test("viewport and UI flushers run before the store snapshot and native disk flush", async () => {
    const { service } = await maintenance(true);
    const calls: string[] = [];
    let viewport = "old viewport";
    let persisted = "";
    const removeStore = service.registerStorageFlusher(async () => {
        calls.push("store");
        await service.queueStorageWrite(async () => { persisted = viewport; calls.push("write"); });
    }, 0);
    const removeViewport = service.registerStorageFlusher(() => { calls.push("viewport"); viewport = "latest viewport"; }, -100);
    const removeUi = service.registerStorageFlusher(() => { calls.push("ui"); }, -50);
    spyOn(desktop, "desktopInvoke").mockImplementation(async () => { calls.push("disk"); return undefined as any; });
    await service.flushStorage();
    expect(calls).toEqual(["viewport", "ui", "store", "write", "disk"]);
    expect(persisted).toBe("latest viewport");
    removeViewport(); removeUi(); removeStore();
});

test("maintenance rejects editing and nested work, releases its lease on failure, and allows later writes", async () => {
    const { service, commands } = await maintenance(true);
    const entered = deferred();
    const gate = deferred();
    const operation = service.withStorageMaintenance("export", async () => {
        entered.resolve();
        await gate.promise;
        throw new Error("export failed");
    });
    await entered.promise;
    expect(service.getMaintenanceLease()).toBe("test-lease");
    expect(service.getMaintenanceState()).toMatchObject({ busy: true, label: "export" });
    let wrote = false;
    await expect(service.queueStorageWrite(async () => { wrote = true; })).rejects.toThrow("写入已暂停");
    expect(() => service.startStorageActivity()).toThrow("维护中");
    await expect(service.withStorageMaintenance("nested", async () => undefined)).rejects.toThrow();
    gate.resolve();
    await expect(operation).rejects.toThrow("export failed");
    expect(wrote).toBe(false);
    expect(service.getMaintenanceState().busy).toBe(false);
    expect(service.getMaintenanceLease()).toBeUndefined();
    expect(commands.at(-1)).toEqual({ command: "desktop_maintenance_end", args: { token: "test-lease" } });
    await service.queueStorageWrite(async () => { wrote = true; });
    expect(wrote).toBe(true);
});

test("confirmed shutdown freezes new work before saving and stays frozen after the host accepts close", async () => {
    const { service, commands } = await maintenance(true);
    const finishExisting = service.startStorageActivity();
    const enteredFlush = deferred();
    const allowFlush = deferred();
    const enteredClose = deferred();
    const allowClose = deferred();
    const unregister = service.registerStorageFlusher(async () => {
        enteredFlush.resolve();
        await allowFlush.promise;
        await service.queueStorageWrite(async () => undefined);
    });
    let settled = false;
    void service.withStorageShutdown("closing", async () => {
        enteredClose.resolve();
        await allowClose.promise;
    }).then(() => { settled = true; });
    await enteredFlush.promise;
    expect(service.getMaintenanceState()).toMatchObject({ busy: true, label: "closing", activities: 1 });
    expect(() => service.startStorageActivity()).toThrow("维护中");
    await expect(service.withStorageMaintenance("move directory", async () => undefined)).rejects.toThrow();
    allowFlush.resolve();
    await enteredClose.promise;
    expect(commands.map(({ command }) => command)).toEqual(["desktop_storage_flush"]);
    await expect(service.queueStorageWrite(async () => undefined)).rejects.toThrow("写入已暂停");
    allowClose.resolve();
    await Promise.resolve();
    finishExisting();
    expect(service.getMaintenanceState()).toMatchObject({ busy: true, activities: 0 });
    expect(settled).toBe(false);
    await expect(service.withStorageShutdown("again", async () => undefined)).rejects.toThrow();
    unregister();
});

test("shutdown failures release the freeze without closing unsaved data or blocking later writes", async () => {
    const { service } = await maintenance(true);
    let closed = false;
    const unregister = service.registerStorageFlusher(() => { throw new Error("viewport save failed"); });
    await expect(service.withStorageShutdown("closing", async () => { closed = true; })).rejects.toThrow("viewport save failed");
    expect(closed).toBe(false);
    expect(service.getMaintenanceState().busy).toBe(false);
    unregister();
    await expect(service.withStorageShutdown("closing", async () => { throw new Error("host close failed"); })).rejects.toThrow("host close failed");
    expect(service.getMaintenanceState().busy).toBe(false);
    await service.queueStorageWrite(async () => undefined);
    const finish = service.startStorageActivity();
    finish();
    await service.withStorageMaintenance("backup", async () => {
        await expect(service.withStorageShutdown("closing", async () => undefined)).rejects.toThrow();
    });
});

test("retrying a disk failure replays the failed and later writes without replacing newer state", async () => {
    const { service } = await maintenance();
    const calls: string[] = [];
    let failOnce = true;
    let persisted = "initial";
    const older = service.queueStorageWrite(async () => {
        calls.push("old");
        if (failOnce) { failOnce = false; throw new Error("disk full"); }
        persisted = "old";
    });
    const newer = service.queueStorageWrite(async () => { calls.push("new"); persisted = "new"; });
    await expect(older).rejects.toThrow("disk full");
    await newer;
    expect(persisted).toBe("new");
    await service.flushStorage();
    expect(calls).toEqual(["old", "new", "old", "new"]);
    expect(persisted).toBe("new");
    await service.flushStorage();
    expect(calls).toHaveLength(4);
});

test("persistent disk errors keep flush failing until every pending write can be recovered", async () => {
    const { service, commands } = await maintenance(true);
    let unavailable = true;
    let persisted = "initial";
    const older = service.queueStorageWrite(async () => {
        if (unavailable) throw new Error("disk unavailable");
        persisted = "old";
    });
    const newer = service.queueStorageWrite(async () => { persisted = "new"; });
    await expect(older).rejects.toThrow("disk unavailable");
    await newer;
    await expect(service.flushStorage()).rejects.toThrow("disk unavailable");
    await expect(service.flushStorage()).rejects.toThrow("disk unavailable");
    expect(commands).toHaveLength(0);
    unavailable = false;
    await service.flushStorage();
    expect(persisted).toBe("new");
    expect(commands.map(({ command }) => command)).toEqual(["desktop_storage_flush"]);
});

test("permanent rejection does not enter the IO journal or prevent recovery of a real disk failure", async () => {
    const { service } = await maintenance();
    let unavailable = true;
    const calls: string[] = [];
    await expect(service.queueStorageWrite(async () => {
        calls.push("disk");
        if (unavailable) throw new Error("disk full");
    })).rejects.toThrow("disk full");
    await expect(service.queueStorageWrite(async () => {
        calls.push("conflict");
        throw new service.StorageWriteRejected("existing media differs");
    })).rejects.toThrow("existing media differs");
    await expect(service.queueStorageWrite(async () => { calls.push("invalid IO"); }, () => {
        throw new Error("invalid value");
    })).rejects.toThrow("invalid value");
    await expect(service.queueStorageWrite(async () => { throw new DOMException("unsupported browser value", "DataCloneError"); })).rejects.toThrow("unsupported browser value");
    unavailable = false;
    await service.queueStorageWrite(async () => { calls.push("newer"); });
    await service.flushStorage();
    expect(calls).toEqual(["disk", "conflict", "newer", "disk", "newer"]);
    await service.flushStorage();
    expect(calls).toHaveLength(5);
});

test("a recovered UI flusher can save again without leaving a stale fatal error", async () => {
    const { service, commands } = await maintenance(true);
    let unavailable = true;
    const unregister = service.registerStorageFlusher(() => { if (unavailable) throw new Error("viewport unavailable"); }, -100);
    await expect(service.flushStorage()).rejects.toThrow("viewport unavailable");
    expect(commands).toHaveLength(0);
    unavailable = false;
    try {
        await service.flushStorage();
        expect(commands.map(({ command }) => command)).toEqual(["desktop_storage_flush"]);
    } finally { unregister(); }
});

test("a successful write replay must not hide a separate failure to flush the current UI", async () => {
    const { service, commands } = await maintenance(true);
    let first = true;
    await expect(service.queueStorageWrite(async () => {
        if (first) { first = false; throw new Error("write failed once"); }
    })).rejects.toThrow("write failed once");
    const unregister = service.registerStorageFlusher(() => { throw new Error("viewport still unavailable"); }, -100);
    try {
        await expect(service.flushStorage()).rejects.toThrow("viewport still unavailable");
        expect(commands).toHaveLength(0);
    } finally { unregister(); }
});

test("cleanup protects shared media, string references, undo history, plugin binaries, and new candidates", async () => {
    const encode = (value: unknown, id = "plugin-binary") => encodeStoredValue(value, async (blob) => ({ id, size: blob.size, type: blob.type }));
    const records: driver.StoredRecord[] = [
        { namespace: "app_state", key: "canvas", value: await encode(JSON.stringify({
            projects: [
                { nodes: [{ data: { storageKey: "image:shared" }, metadata: { references: ["video:reference", "image:reference"] } }] },
                { nodes: [{ data: { storageKey: "image:shared" } }] },
            ],
        })) },
        { namespace: "video_generation_logs", key: "history", value: await encode({ storageKey: "video:shared" }) },
        { namespace: "plugin:example", key: "private", value: await encode({ bytes: new Blob(["plugin"]), references: new Set(["audio:plugin"]), serialized: JSON.stringify({ storageKey: "custom:referenced" }) }) },
        { namespace: "image_previews", key: "image:shared", value: await encode({ version: 1, blob: new Blob(["shared preview"]) }, "preview-shared") },
        { namespace: "image_previews", key: "image:orphan", value: await encode({ version: 1, blob: new Blob(["orphan preview"]) }, "preview-orphan") },
        { namespace: "image_previews", key: "image:undo", value: await encode({ version: 1, blob: new Blob(["undo preview"]) }, "preview-undo") },
    ];
    const blob = (namespace: string, key: string): driver.StoredBlob => ({ namespace, key, mime: "", size: 1, sha256: "test" });
    const approved = [blob("image_files", "image:orphan"), blob("image_previews", "preview-orphan")];
    spyOn(driver, "listDesktopRecords").mockResolvedValue(records);
    spyOn(driver, "listDesktopBlobs").mockResolvedValue([...approved, blob("image_files", "image:new-after-scan")]);
    const unregister = registerMediaReferences(() => ({ undo: [{ storageKey: "image:undo" }], redo: [{ metadata: { references: ["video:undo"] } }] }));
    try {
        const key = ({ namespace, key }: { namespace: string; key: string }) => `${namespace}/${key}`;
        const references = (await currentMediaReferences()).map(key);
        expect(references.filter((value) => value === "image_files/image:shared")).toHaveLength(1);
        for (const value of [
            "image_files/image:reference", "media_files/video:reference", "media_files/video:shared", "media_files/audio:plugin",
            "media_files/custom:referenced",
            "image_files/image:undo", "media_files/video:undo", "plugin-binary/plugin-binary", "image_previews/preview-shared", "image_previews/preview-undo",
        ]) expect(references).toContain(value);
        expect(references).not.toContain("image_previews/preview-orphan");
        const confirmed = (await currentMediaReferences(approved)).map(key);
        expect(confirmed).toContain("image_files/image:new-after-scan");
        expect(confirmed).not.toContain("image_files/image:orphan");
        expect(confirmed).not.toContain("image_previews/preview-orphan");
        records.push({ namespace: "app_state", key: "assets", value: await encode({ storageKey: "image:orphan" }) });
        const reused = (await currentMediaReferences(approved)).map(key);
        expect(reused).toContain("image_files/image:orphan");
        expect(reused).toContain("image_previews/preview-orphan");
    } finally { unregister(); }
});
