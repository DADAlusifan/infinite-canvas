import { desktopBlobUrl, getDesktopRuntime, isDesktop } from "@/services/desktop/runtime";
import { applicationPreferences } from "./preferences";
import { binaryNamespace, browserStore, listDesktopBlobs, listDesktopRecords, listStorageNamespaces, readDesktopBlob } from "./driver";
import { encodeStoredValue } from "./codec";
import { sha256Blob, sha256Stream } from "./transfer";
import { withStorageMaintenance } from "./maintenance";
import type { BackupSnapshot, BackupSource } from "./backup-types";

const fallbackKeys = new Set(["infinite-canvas:canvas_store", "infinite-canvas:asset_store", "infinite-canvas:plugin_store"]);

async function snapshot(signal?: AbortSignal): Promise<BackupSnapshot> {
    signal?.throwIfAborted();
    const result: BackupSnapshot = { records: [], blobs: [], runtimeUrlPrefix: getDesktopRuntime()?.apiBase };
    if (isDesktop()) {
        result.records = (await listDesktopRecords()).map((record) => ({ ...record, kind: record.namespace === "preferences" ? "preference" : "value" }));
        result.blobs = (await listDesktopBlobs()).map((record) => ({
            namespace: record.namespace, key: record.key, mimeType: record.mime, bytes: record.size, sha256: record.sha256,
            stream: async (readSignal) => {
                readSignal?.throwIfAborted();
                const response = await fetch(desktopBlobUrl(record.namespace, record.key), { signal: readSignal });
                if (!response.ok || !response.body) {
                    await response.body?.cancel();
                    throw new Error(`本地文件缺失或无法读取：${record.namespace}/${record.key}`);
                }
                return response.body;
            },
            read: async (readSignal) => {
                const blob = await readDesktopBlob(record.namespace, record.key, readSignal);
                if (!blob || await sha256Blob(blob, readSignal) !== record.sha256) throw new Error(`本地文件缺失或被修改：${record.namespace}/${record.key}`);
                return blob;
            },
        }));
        return result;
    }
    if (typeof indexedDB === "undefined" || !indexedDB.databases) throw new Error("当前浏览器无法枚举完整数据，请使用 Chrome 或 Edge 导出");
    const binaries = new Set<string>();
    const appState = new Map<string, unknown>();
    for (const namespace of (await listStorageNamespaces()).sort()) {
        const store = browserStore(namespace);
        for (const key of (await store.keys()).sort()) {
            signal?.throwIfAborted();
            const value = await store.getItem(key);
            if (namespace === "app_state") appState.set(key, value);
            if (namespace === "image_files" || namespace === "media_files") {
                if (!(value instanceof Blob)) throw new Error(`媒体记录格式错误：${namespace}/${key}`);
                result.blobs.push({ namespace, key, mimeType: value.type, bytes: value.size, read: async () => {
                    const current = await store.getItem<Blob>(key);
                    if (!(current instanceof Blob)) throw new Error(`媒体在导出期间缺失：${key}`);
                    return current;
                } });
                continue;
            }
            const encoded = await encodeStoredValue(value, async (blob) => {
                const id = await sha256Blob(blob, signal), target = binaryNamespace(namespace), identity = `${target}/${id}`;
                if (!binaries.has(identity)) {
                    binaries.add(identity);
                    result.blobs.push({ namespace: target, key: id, mimeType: blob.type, bytes: blob.size, read: async () => blob });
                }
                return { id, size: blob.size, type: blob.type };
            });
            result.records.push({ namespace, key, value: encoded, kind: "value" });
        }
    }
    for (const [key, value] of Object.entries(applicationPreferences())) {
        if (fallbackKeys.has(key)) {
            if (appState.has(key) && appState.get(key) !== value) throw new Error(`IndexedDB 与备用存储内容冲突：${key}，请先确认要保留的数据`);
            if (!appState.has(key)) result.records.push({ namespace: "app_state", key, value: await encodeStoredValue(value, async () => { throw new Error("备用配置格式错误"); }), kind: "value" });
        } else result.records.push({ namespace: "preferences", key, value, kind: "preference" });
    }
    return result;
}

export const applicationBackupSource: BackupSource = {
    snapshot,
    async fingerprint(signal) {
        const data = await snapshot(signal);
        const binaries = [];
        for (const blob of data.blobs) {
            signal?.throwIfAborted();
            const hash = blob.stream ? await sha256Stream(await blob.stream(signal), signal) : await sha256Blob(await blob.read(signal), signal);
            if (blob.sha256 && hash !== blob.sha256) throw new Error(`本地文件缺失或被修改：${blob.namespace}/${blob.key}`);
            binaries.push({ namespace: blob.namespace, key: blob.key, hash });
        }
        return sha256Blob(new Blob([JSON.stringify({ records: data.records, binaries })]), signal);
    },
    withMaintenance: (work) => withStorageMaintenance("正在导出完整备份，请勿编辑其他应用标签页", work),
};
