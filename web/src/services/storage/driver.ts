import localforage from "localforage";
import { desktopBlobUrl, desktopInvoke, isDesktop } from "@/services/desktop/runtime";
import { decodeStoredValue, encodeStoredValue } from "./codec";
import { getMaintenanceLease, queueStorageWrite, StorageWriteRejected } from "./maintenance";
import { getDesktopRuntime } from "@/services/desktop/runtime";
import { sanitizeStoredUrls } from "./transfer";

export type StoredRecord = { namespace: string; key: string; value: string };
export type StoredBlob = { namespace: string; key: string; mime: string; size: number; sha256: string };
export type StorageMutation = { op: "set" | "remove" | "clear"; namespace: string; key?: string; value?: string };
export interface DataStore {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
    keys(): Promise<string[]>;
    iterate<T>(iterator: (value: T, key: string, iteration: number) => void): Promise<void>;
    replace<T>(entries: Array<[string, T]>): Promise<void>;
}

const stores = new Map<string, DataStore>();
const browserStores = new Map<string, LocalForage>();
export const binaryNamespace = (namespace: string) => namespace === "image_previews" ? "image_previews" : "plugin-binary";
const isMediaStore = (namespace: string) => namespace === "image_files" || namespace === "media_files";

export function browserStore(namespace: string) {
    let store = browserStores.get(namespace);
    if (!store) {
        store = localforage.createInstance({ name: namespace.startsWith("plugin:") ? "infinite-canvas-plugins" : "infinite-canvas", storeName: namespace.startsWith("plugin:") ? namespace.slice(7) : namespace });
        browserStores.set(namespace, store);
    }
    return store;
}

export function listDesktopRecords(namespace?: string) {
    return desktopInvoke<StoredRecord[]>("desktop_records_list", { namespace });
}

export function listDesktopBlobs(namespace?: string) {
    return desktopInvoke<StoredBlob[]>("desktop_blob_list", { namespace });
}

export function writeDesktopRecords(mutations: StorageMutation[]) {
    return desktopInvoke<number>("desktop_records_batch", { mutations, lease: getMaintenanceLease() });
}

export async function putDesktopBlob(namespace: string, key: string, blob: Blob) {
    const headers: Record<string, string> = { "Content-Type": blob.type || "application/octet-stream" };
    const lease = getMaintenanceLease();
    if (lease) headers["x-desktop-lease"] = lease;
    const response = await fetch(desktopBlobUrl(namespace, key), { method: "PUT", headers, body: blob });
    if (response.status === 409) throw new StorageWriteRejected("该媒体键的内容冲突或原文件已被修改，已拒绝覆盖");
    if (!response.ok) throw new Error(`媒体保存失败（${response.status}）`);
}

export async function readDesktopBlob(namespace: string, key: string, signal?: AbortSignal) {
    const response = await fetch(desktopBlobUrl(namespace, key), { signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`媒体读取失败（${response.status}）`);
    return response.blob();
}

type PreparedRecord = { value: string; binaries: Array<{ id: string; blob: Blob }> };

async function prepareRecord(namespace: string, value: unknown): Promise<PreparedRecord> {
    if (["app_state", "image_generation_logs", "video_generation_logs"].includes(namespace)) value = sanitizeStoredUrls(value, getDesktopRuntime()?.apiBase);
    const binaries: PreparedRecord["binaries"] = [];
    const encoded = await encodeStoredValue(value, async (blob) => {
        const id = crypto.randomUUID();
        binaries.push({ id, blob });
        return { id, size: blob.size, type: blob.type };
    });
    return { value: encoded, binaries };
}

function validateWrite(namespace: string) {
    if (!isDesktop()) return;
    const known = ["app_state", "preferences", "image_generation_logs", "video_generation_logs", "prompt_cache", "image_previews", "image_files", "media_files"];
    if ((!known.includes(namespace) && !(namespace.startsWith("plugin:") && namespace.length > 7)) || /[\u0000-\u001f\u007f-\u009f]/.test(namespace)) throw new Error("不支持的记录命名空间");
}

function validateKey(key: string) {
    if (typeof key !== "string" || !key || key.includes("\0")) throw new Error("存储键不能为空或包含空字符");
}

async function writeRecordBinaries(namespace: string, record: PreparedRecord) {
    for (const binary of record.binaries) await putDesktopBlob(binaryNamespace(namespace), binary.id, binary.blob);
}

async function decode<T>(namespace: string, value: string): Promise<T> {
    return decodeStoredValue<T>(value, async (ref) => {
        const blob = await readDesktopBlob(binaryNamespace(namespace), ref.id);
        if (!blob) throw new Error("本地二进制文件缺失，请从备份恢复");
        return blob;
    });
}

export function createStorage(namespace: string): DataStore {
    const existing = stores.get(namespace);
    if (existing) return existing;
    const store: DataStore = {
        async getItem<T>(key: string) {
            if (!isDesktop()) return browserStore(namespace).getItem<T>(key);
            if (isMediaStore(namespace)) return await readDesktopBlob(namespace, key) as T | null;
            const value = await desktopInvoke<string | null>("desktop_records_get", { namespace, key });
            return value === null ? null : decode<T>(namespace, value);
        },
        setItem<T>(key: string, value: T) {
            let record: PreparedRecord;
            return queueStorageWrite(async () => {
                if (!isDesktop()) return browserStore(namespace).setItem(key, value);
                if (isMediaStore(namespace)) {
                    await putDesktopBlob(namespace, key, value as Blob);
                } else {
                    await writeRecordBinaries(namespace, record);
                    await writeDesktopRecords([{ op: "set", namespace, key, value: record.value }]);
                }
                return value;
            }, async () => {
                validateWrite(namespace);
                if (!isDesktop()) return;
                validateKey(key);
                if (isMediaStore(namespace)) {
                    if (!(value instanceof Blob)) throw new Error("媒体存储只接受文件内容");
                } else record = await prepareRecord(namespace, value);
            });
        },
        removeItem(key) {
            return queueStorageWrite(async () => {
                if (!isDesktop()) return browserStore(namespace).removeItem(key);
                // Desktop binaries are only removed by the explicit, reference-checked cleanup operation.
                if (!isMediaStore(namespace)) await writeDesktopRecords([{ op: "remove", namespace, key }]);
            }, () => { validateWrite(namespace); if (isDesktop()) validateKey(key); });
        },
        clear() {
            return queueStorageWrite(async () => {
                if (!isDesktop()) return browserStore(namespace).clear();
                if (!isMediaStore(namespace)) await writeDesktopRecords([{ op: "clear", namespace }]);
            }, () => validateWrite(namespace));
        },
        async keys() {
            if (!isDesktop()) return browserStore(namespace).keys();
            return (isMediaStore(namespace) ? await listDesktopBlobs(namespace) : await listDesktopRecords(namespace)).map((entry) => entry.key);
        },
        async iterate<T>(iterator: (value: T, key: string, iteration: number) => void) {
            if (!isDesktop()) { await browserStore(namespace).iterate<T, void>(iterator); return; }
            let index = 0;
            for (const key of await store.keys()) {
                const value = await store.getItem<T>(key);
                if (value !== null) iterator(value, key, ++index);
            }
        },
        replace<T>(entries: Array<[string, T]>) {
            const records: Array<{ key: string; record: PreparedRecord }> = [];
            return queueStorageWrite(async () => {
                if (!isDesktop()) {
                    const original = await Promise.all((await store.keys()).map(async (key) => [key, await store.getItem(key)] as const));
                    try { await browserStore(namespace).clear(); for (const [key, value] of entries) await browserStore(namespace).setItem(key, value); }
                    catch (error) { await browserStore(namespace).clear(); for (const [key, value] of original) await browserStore(namespace).setItem(key, value); throw error; }
                    return;
                }
                const mutations: StorageMutation[] = [{ op: "clear", namespace }];
                for (const { key, record } of records) {
                    await writeRecordBinaries(namespace, record);
                    mutations.push({ op: "set", namespace, key, value: record.value });
                }
                await writeDesktopRecords(mutations);
            }, async () => {
                validateWrite(namespace);
                if (!isDesktop()) return;
                if (isMediaStore(namespace)) throw new Error("媒体不能批量覆盖");
                for (const [key, value] of entries) {
                    validateKey(key);
                    records.push({ key, record: await prepareRecord(namespace, value) });
                }
            });
        },
    };
    stores.set(namespace, store);
    return store;
}

export async function listStorageNamespaces() {
    if (isDesktop()) return [...new Set([...(await listDesktopRecords()).map((r) => r.namespace), ...(await listDesktopBlobs()).map((r) => r.namespace)])];
    const result = new Set<string>();
    if (typeof indexedDB !== "undefined" && indexedDB.databases) {
        for (const item of await indexedDB.databases()) {
            if (item.name !== "infinite-canvas" && item.name !== "infinite-canvas-plugins") continue;
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(item.name!);
                request.onupgradeneeded = () => request.transaction!.abort();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try { for (const name of db.objectStoreNames) if (name !== "local-forage-detect-blob-support") result.add(item.name === "infinite-canvas-plugins" ? `plugin:${name}` : name); }
            finally { db.close(); }
        }
    } else for (const name of stores.keys()) result.add(name);
    return [...result];
}
