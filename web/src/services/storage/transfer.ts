import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js";
import { createSHA256 } from "hash-wasm";

const urlFields = new Set(["url", "dataUrl", "coverUrl", "content", "previewUrl", "thumbnailUrl"]);
const mediaKey = /^(image|video|audio|file|video-reference|audio-reference):[^/\\\s]+$/;
const textFields = new Set(["content", "text", "prompt", "systemPrompt", "title", "description", "note", "script", "url", "dataUrl", "coverUrl", "previewUrl", "thumbnailUrl"]);

export async function sha256Stream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
    const reader = stream.getReader();
    const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
        signal?.throwIfAborted();
        const hash = await createSHA256();
        hash.init();
        while (true) {
            signal?.throwIfAborted();
            const { value, done } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            hash.update(value);
        }
        return hash.digest("hex");
    } finally {
        signal?.removeEventListener("abort", abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

export function sha256Blob(blob: Blob, signal?: AbortSignal): Promise<string> {
    return sha256Stream(blob.stream(), signal);
}

/** Preserve remote URLs and storage identities; runtime URLs cannot survive an export or restart. */
export function sanitizeStoredUrls<T>(value: T, runtimeUrlPrefix?: string): T {
    if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { return value; }
        return JSON.stringify(sanitizeStoredUrls(parsed, runtimeUrlPrefix)) as T;
    }
    const seen = new WeakMap<object, object>();
    const isTemporary = (url: unknown) => typeof url === "string" && (url.startsWith("blob:") || Boolean(runtimeUrlPrefix && url.startsWith(`${runtimeUrlPrefix}/`)));
    const visit = (item: any, label: string, textData = false): any => {
        if (!item || typeof item !== "object") return item;
        if (seen.has(item)) return seen.get(item);
        if (item instanceof Map) {
            const result = new Map(); seen.set(item, result);
            for (const [key, entry] of item) result.set(visit(key, label), visit(entry, label));
            return result;
        }
        if (item instanceof Set) {
            const result = new Set(); seen.set(item, result);
            for (const entry of item) result.add(visit(entry, label));
            return result;
        }
        if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return item;
        const result: any = Array.isArray(item) ? new Array(item.length) : Object.create(Object.getPrototypeOf(item));
        seen.set(item, result);
        const storageKey = item.storageKey || item.data?.storageKey || item.metadata?.storageKey;
        for (const key of Object.keys(item)) {
            const original = item[key];
            const temporary = isTemporary(original);
            if (key === "references" && Array.isArray(original) && original.some(isTemporary)) throw new Error(`${label}.references 包含无法恢复的临时参考素材地址`);
            const childTextData = (item.type === "text" && key === "metadata") || (item.kind === "text" && key === "data");
            let next = visit(original, `${label}.${key}`, childTextData);
            if (urlFields.has(key) && temporary && !(textData && key === "content")) {
                if (typeof storageKey !== "string" || !storageKey) throw new Error(`${label}.${key} 只有临时地址，无法恢复原文件`);
                next = "";
            }
            Object.defineProperty(result, key, { value: next, writable: true, enumerable: true, configurable: true });
        }
        return result;
    };
    return visit(value, "数据");
}

export function collectStoredMediaKeys(value: unknown, keys = new Set<string>(), seen = new WeakSet<object>()): Set<string> {
    const referenceSeen = new WeakSet<object>();
    const property = (key: unknown, entry: unknown) => {
        if (key === "storageKey" && typeof entry === "string" && entry.includes(":")) { keys.add(entry); return; }
        if (typeof key === "string" && textFields.has(key) && typeof entry === "string") return;
        visit(entry, key === "references");
    };
    const visit = (item: unknown, referenceList = false): void => {
        if (typeof item === "string") {
            if (referenceList && mediaKey.test(item)) keys.add(item);
            else if (!referenceList && /^\s*[\[{]/.test(item)) {
                let parsed: unknown;
                try { parsed = JSON.parse(item); } catch { return; }
                visit(parsed);
            }
            return;
        }
        if (!item || typeof item !== "object") return;
        const visited = referenceList ? referenceSeen : seen;
        if (visited.has(item)) return;
        visited.add(item);
        if (Array.isArray(item) || item instanceof Set) for (const entry of item) visit(entry, referenceList);
        else if (item instanceof Map) for (const [key, entry] of item) {
            if (typeof key !== "string") visit(key);
            property(key, entry);
        }
        else for (const [key, entry] of Object.entries(item)) property(key, entry);
    };
    visit(value);
    return keys;
}

function validArchivePath(path: unknown): path is string {
    return typeof path === "string" && !!path && !path.includes("\\") && !path.includes(":") && !path.includes("\0") && path.split("/").every((part) => !!part && part !== "." && part !== "..");
}

/** ZIP entry names and CRCs are checked before callers write any application data. */
export async function readTransferZip(file: Blob): Promise<Map<string, Blob>> {
    const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
    try {
        const entries = await reader.getEntries();
        const names = new Set<string>();
        for (const entry of entries) {
            const name = entry.directory ? entry.filename.replace(/\/$/, "") : entry.filename;
            if (!validArchivePath(name) || names.has(entry.filename)) throw new Error("导入包包含非法或重复文件路径");
            names.add(entry.filename);
        }
        const files = new Map<string, Blob>();
        for (const entry of entries) if (!entry.directory) files.set(entry.filename, await entry.getData(new BlobWriter(), { checkSignature: true }));
        return files;
    } finally { await reader.close(); }
}

export type TransferMediaEntry = { storageKey: string; path: string; mimeType: string; bytes: number };
export type PreparedMediaWrite = { storageKey: string; blob: Blob };

/** Full preflight: content conflicts and missing files are rejected before the first write. */
export async function prepareMediaImport(
    value: unknown,
    files: TransferMediaEntry[],
    archive: Map<string, Blob>,
    readExisting: (storageKey: string) => Promise<Blob | null>,
): Promise<PreparedMediaWrite[]> {
    if (!Array.isArray(files)) throw new Error("导入包缺少媒体清单");
    const staged = new Map<string, { blob: Blob; hash: string }>();
    for (const entry of files) {
        if (!entry || typeof entry.storageKey !== "string" || !entry.storageKey.includes(":") || !validArchivePath(entry.path) || typeof entry.mimeType !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("媒体清单格式不正确");
        const file = archive.get(entry.path);
        if (!file || file.size !== entry.bytes) throw new Error(`导入包缺少媒体或大小不匹配：${entry.storageKey}`);
        const blob = file.slice(0, file.size, entry.mimeType);
        const hash = await sha256Blob(blob);
        const previous = staged.get(entry.storageKey);
        if (previous && previous.hash !== hash) throw new Error(`导入包包含内容冲突的媒体键：${entry.storageKey}`);
        staged.set(entry.storageKey, { blob, hash });
    }
    for (const key of collectStoredMediaKeys(value)) if (!staged.has(key)) throw new Error(`导入包未包含引用的媒体：${key}`);
    const writes: PreparedMediaWrite[] = [];
    for (const [storageKey, entry] of staged) {
        const existing = await readExisting(storageKey);
        if (!existing) writes.push({ storageKey, blob: entry.blob });
        else if (existing.size !== entry.blob.size || await sha256Blob(existing) !== entry.hash) throw new Error(`本地已有同名但内容不同的媒体，导入已取消：${storageKey}`);
    }
    return writes;
}
