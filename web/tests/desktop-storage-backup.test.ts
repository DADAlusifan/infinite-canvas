import { expect, spyOn, test } from "bun:test";
import { BlobReader, TextWriter, ZipReader, BlobWriter } from "@zip.js/zip.js";
import { decodeStoredValue, encodeStoredValue, inspectStoredValue } from "../src/services/storage/codec";
import { exportFullBackup, prepareBackupSnapshot, sha256Blob } from "../src/services/storage/backup";
import type { BackupSnapshot, BackupSource, BackupTarget } from "../src/services/storage/backup-types";
import { prepareMediaImport, readTransferZip, sanitizeStoredUrls } from "../src/services/storage/transfer";
import { createZip } from "../src/lib/zip";

function binaryStore() {
    const blobs = new Map<string, Blob>();
    return {
        blobs,
        write: async (blob: Blob) => {
            const id = `binary-${blobs.size}`;
            blobs.set(id, blob);
            return { id, size: blob.size, type: blob.type };
        },
        read: async ({ id }: { id: string }) => {
            const blob = blobs.get(id);
            if (!blob) throw new Error("missing binary");
            return blob;
        },
    };
}

test("storage codec preserves cycles, shared binary buffers, sparse arrays and plugin value types", async () => {
    const store = binaryStore();
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const file = new File(["plugin bytes"], "测试.bin", { type: "application/octet-stream", lastModified: 1234 });
    const expression = /canvas/gy;
    expression.lastIndex = 7;
    const sparse = new Array(4); sparse[2] = undefined;
    const source: any = {
        date: new Date("2024-01-01T00:00:00Z"), url: new URL("https://example.test/path"), bigint: BigInt("9007199254740993"),
        nan: NaN, infinity: Infinity, absent: undefined, expression, sparse,
        nullObject: Object.assign(Object.create(null), { data: 2 }), buffer,
        view: new Uint16Array(buffer, 2, 1), dataView: new DataView(buffer, 1, 2), file, alias: file,
    };
    source.self = source;
    source.map = new Map([[source, file]]);
    source.set = new Set([source, file]);
    const encoded = await encodeStoredValue(source, store.write);
    const result = await decodeStoredValue<any>(encoded, store.read);
    expect(result.self).toBe(result);
    expect(result.alias).toBe(result.file);
    expect(result.map.get(result)).toBe(result.file);
    expect(result.set.has(result)).toBe(true);
    expect(result.view.buffer).toBe(result.buffer);
    expect(result.dataView.buffer).toBe(result.buffer);
    expect([...new Uint8Array(result.buffer)]).toEqual([1, 2, 3, 4]);
    expect(result.view.byteOffset).toBe(2);
    expect(result.dataView.byteLength).toBe(2);
    expect(result.file.name).toBe("测试.bin");
    expect(result.file.lastModified).toBe(1234);
    expect(await result.file.text()).toBe("plugin bytes");
    expect(result.date.getTime()).toBe(source.date.getTime());
    expect(result.url.href).toBe(source.url.href);
    expect(result.bigint).toBe(source.bigint);
    expect(Number.isNaN(result.nan)).toBe(true);
    expect(result.infinity).toBe(Infinity);
    expect("absent" in result).toBe(true);
    expect(Object.getPrototypeOf(result.nullObject)).toBeNull();
    expect(result.expression.lastIndex).toBe(7);
    expect(result.sparse.length).toBe(4);
    expect(0 in result.sparse).toBe(false);
    expect(2 in result.sparse).toBe(true);
    expect(store.blobs.size).toBe(2);
});

test("unsupported plugin values fail before any binary is persisted", async () => {
    const store = binaryStore();
    for (const invalid of [() => undefined, Symbol("private"), new WeakMap(), new (class PluginObject {})(), Object.assign(new Date(), { extra: 1 }), Object.defineProperty({}, "value", { get: () => 1, enumerable: true })]) {
        await expect(encodeStoredValue({ file: new Blob(["data"]), invalid }, store.write)).rejects.toThrow();
    }
    expect(store.blobs.size).toBe(0);
    const encoded = await encodeStoredValue(new Blob(["data"]), store.write);
    await expect(decodeStoredValue(encoded, async () => new Blob(["truncated"]))).rejects.toThrow("缺失或损坏");
});

function memoryTarget() {
    const chunks: Uint8Array[] = [];
    let committed = false;
    let aborted = false;
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { chunks.push(chunk.slice()); } });
    const target: BackupTarget = {
        writable,
        async commit() { await writable.close(); committed = true; },
        async abort(reason) { aborted = true; await writable.abort(reason); },
    };
    return { target, content: () => new Blob(chunks), committed: () => committed, aborted: () => aborted };
}

function memorySource(snapshot: BackupSnapshot): BackupSource {
    return { snapshot: async () => snapshot, fingerprint: async () => "stable", withMaintenance: (work) => work() };
}

test("complete ZIP64 export round trips records, orphan media, plugin binaries and raw preferences", async () => {
    const store = binaryStore();
    const pluginValue: any = { file: new File(["binary plugin data"], "private.dat"), dimensions: ["2048x2048"] };
    pluginValue.self = pluginValue;
    pluginValue.members = new Set([pluginValue, pluginValue.file]);
    const encoded = await encodeStoredValue(pluginValue, store.write);
    const original = new Blob(["unreferenced media"], { type: "video/mp4" });
    const snapshot: BackupSnapshot = {
        records: [
            { namespace: "plugin:test", key: "settings", value: encoded, kind: "value" },
            { namespace: "preferences", key: "canvas-agent-url", value: "http://127.0.0.1:17371", kind: "preference" },
        ],
        blobs: [
            { namespace: "media_files", key: "video:orphan", mimeType: original.type, bytes: original.size, read: async () => original },
            ...[...store.blobs].map(([key, blob]) => ({ namespace: "plugin-binary", key, mimeType: blob.type, bytes: blob.size, read: async () => blob })),
        ],
    };
    const output = memoryTarget();
    const manifest = await exportFullBackup(memorySource(snapshot), output.target);
    expect(output.committed()).toBe(true);
    expect(output.aborted()).toBe(false);
    const reader = new ZipReader(new BlobReader(output.content()), { useWebWorkers: false });
    const entries = await reader.getEntries();
    const file = (path: string) => {
        const entry = entries.find((item) => item.filename === path);
        if (!entry || entry.directory) throw new Error("entry missing");
        return entry;
    };
    expect(JSON.parse(await file("manifest.json").getData(new TextWriter()))).toEqual(manifest);
    expect(manifest.counts.records).toBe(2);
    expect(manifest.counts.binaries).toBe(2);
    let total = 0;
    for (const descriptor of [...manifest.records, ...manifest.blobs]) {
        const content = await file(descriptor.path).getData(new BlobWriter());
        expect(await sha256Blob(content)).toBe(descriptor.sha256);
        expect(content.size).toBe(descriptor.size);
        total += content.size;
    }
    expect(total).toBe(manifest.counts.bytes);
    const plugin = manifest.records.find((record) => record.namespace === "plugin:test")!;
    const restored = await decodeStoredValue<any>(await file(plugin.path).getData(new TextWriter()), async ({ id }) => {
        const binary = manifest.blobs.find((item) => item.namespace === "plugin-binary" && item.key === id)!;
        return file(binary.path).getData(new BlobWriter(binary.mime));
    });
    expect(await restored.file.text()).toBe("binary plugin data");
    expect(restored.dimensions).toEqual(["2048x2048"]);
    expect(restored.self).toBe(restored);
    expect(restored.members.has(restored)).toBe(true);
    expect(restored.members.has(restored.file)).toBe(true);
    // ZIP64 end-of-central-directory signature remains present even for this small fixture.
    const bytes = new Uint8Array(await output.content().arrayBuffer());
    expect(bytes.some((_, index) => bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x06 && bytes[index + 3] === 0x06)).toBe(true);
    await reader.close();
});

test("backup removes recoverable temporary URLs, keeps signed remote URLs, and rejects missing files", async () => {
    const store = binaryStore();
    const payload = { nodes: [{ storageKey: "image:ok", content: "blob:old-origin" }, { url: "https://example.test/video?signature=preserve" }] };
    const record = { namespace: "app_state", key: "canvas", kind: "value" as const, value: await encodeStoredValue(JSON.stringify(payload), store.write) };
    const snapshot: BackupSnapshot = { records: [record], blobs: [{ namespace: "image_files", key: "image:ok", mimeType: "image/png", bytes: 1, read: async () => new Blob(["a"]) }] };
    const prepared = prepareBackupSnapshot(snapshot);
    const restored = JSON.parse(inspectStoredValue(prepared.records[0].value).value as string);
    expect(restored.nodes[0].content).toBe("");
    expect(restored.nodes[1].url).toBe(payload.nodes[1].url);
    expect(inspectStoredValue(record.value).value).toContain("blob:old-origin");
    expect(() => prepareBackupSnapshot({ ...snapshot, blobs: [] })).toThrow("缺少媒体");
    const temporary = { ...record, value: await encodeStoredValue({ url: "blob:lost" }, store.write) };
    expect(() => prepareBackupSnapshot({ records: [temporary], blobs: [] })).toThrow("只有临时地址");
    const plugin = { ...record, namespace: "plugin:test", value: await encodeStoredValue(new Blob(["nested"]), store.write) };
    expect(() => prepareBackupSnapshot({ records: [plugin], blobs: [] })).toThrow("缺少二进制");
});

test("source changes or cancellation abort output instead of committing a partial archive", async () => {
    const source = memorySource({ records: [{ namespace: "preferences", key: "test", kind: "preference", value: "partial" }], blobs: [] });
    let checks = 0;
    source.fingerprint = async () => String(checks++);
    const output = memoryTarget();
    await expect(exportFullBackup(source, output.target)).rejects.toThrow("源数据发生变化");
    expect(output.committed()).toBe(false);
    expect(output.aborted()).toBe(true);
    const cancelled = memoryTarget();
    await expect(exportFullBackup(memorySource({ records: [], blobs: [] }), cancelled.target, undefined, AbortSignal.abort())).rejects.toThrow();
    expect(cancelled.committed()).toBe(false);
    expect(cancelled.aborted()).toBe(true);
});

test("category imports reuse identical media and reject same-key changes or missing references before writes", async () => {
    const existing = new Blob(["old"]);
    const incoming = new Blob(["new"]);
    const records = [{ storageKey: "image:shared" }, { storageKey: "video:new" }];
    const files = [
        { storageKey: "image:shared", path: "files/shared.bin", bytes: 3, mimeType: "image/png" },
        { storageKey: "video:new", path: "files/new.bin", bytes: 3, mimeType: "video/mp4" },
    ];
    const archive = new Map([[files[0].path, existing], [files[1].path, incoming]]);
    const prepared = await prepareMediaImport(records, files, archive, async (key) => key === "image:shared" ? existing : null);
    expect(prepared.map((item) => item.storageKey)).toEqual(["video:new"]);
    expect(prepared[0].blob.type).toBe("video/mp4");
    archive.set(files[0].path, incoming);
    await expect(prepareMediaImport(records, files, archive, async (key) => key === "image:shared" ? existing : null)).rejects.toThrow("内容不同");
    await expect(prepareMediaImport(records, files.slice(0, 1), archive, async () => null)).rejects.toThrow("未包含引用");
    archive.delete(files[1].path);
    await expect(prepareMediaImport(records, files, archive, async () => null)).rejects.toThrow("缺少媒体");
    await expect(readTransferZip(await createZip([{ name: "../escape.bin", data: incoming }]))).rejects.toThrow();

    const prefix = "http://127.0.0.1:54321/runtime-session";
    const source = { storageKey: "image:shared", url: `${prefix}/blob/image_files/image%3Ashared`, external: { url: "http://127.0.0.1:8000/result" } };
    const cleaned = sanitizeStoredUrls(source, prefix);
    expect(cleaned.url).toBe("");
    expect(source.url).toContain("runtime-session");
    expect(cleaned.external.url).toBe(source.external.url);
    expect(() => sanitizeStoredUrls({ url: `${prefix}/blob/image_files/lost` }, prefix)).toThrow("只有临时地址");
});

test("a later missing canvas attachment prevents all earlier media writes", async () => {
    const imageStorage = await import("../src/services/image-storage");
    const { readCanvasPackage } = await import("../src/lib/canvas/canvas-export");
    const read = spyOn(imageStorage, "getImageBlob").mockResolvedValue(null);
    const write = spyOn(imageStorage, "setImageBlob").mockResolvedValue("blob:test");
    try {
        const project = (id: string) => ({
            id, title: id, createdAt: "", updatedAt: "", nodes: [{ id: `node-${id}`, type: "image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: `image:${id}`, content: "blob:old" } }],
            connections: [], chatSessions: [], viewport: { x: 0, y: 0, k: 1 },
        });
        const manifest = { app: "infinite-canvas", version: 3, projects: ["one", "two"].map((id) => ({ project: project(id), files: [{ storageKey: `image:${id}`, path: `${id}.png`, mimeType: "image/png", bytes: 1 }] })) };
        const zip = await createZip([{ name: "projects.json", data: JSON.stringify(manifest) }, { name: "one.png", data: "a" }]);
        await expect(readCanvasPackage(zip)).rejects.toThrow("缺少媒体");
        expect(write).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); write.mockRestore(); }
});
