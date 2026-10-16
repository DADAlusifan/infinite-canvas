import { BlobReader, ZipWriter } from "@zip.js/zip.js";
import { createSHA256 } from "hash-wasm";
import { inspectStoredValue, transformStoredValue } from "./codec";
import { collectStoredMediaKeys, sanitizeStoredUrls, sha256Blob } from "./transfer";
import type { BackupManifest, BackupProgress, BackupSnapshot, BackupSource, BackupTarget } from "./backup-types";

export { sha256Blob } from "./transfer";
const entryKey = (namespace: string, key: string) => JSON.stringify([namespace, key]);

/** Check local references without fetching remote URLs or reading all media into memory. */
export function prepareBackupSnapshot(snapshot: BackupSnapshot): BackupSnapshot {
    const blobs = new Map(snapshot.blobs.map((blob) => [entryKey(blob.namespace, blob.key), blob]));
    if (blobs.size !== snapshot.blobs.length) throw new Error("备份包含重复的媒体键");
    const records = new Set<string>();
    const problems: string[] = [];
    const normalized = snapshot.records.map((record) => {
        const label = `${record.namespace}/${record.key}`;
        const identity = entryKey(record.namespace, record.key);
        if (records.has(identity)) throw new Error(`备份包含重复的记录：${label}`);
        records.add(identity);
        if (record.kind === "preference") return record;
        const { binaries, value } = inspectStoredValue(record.value);
        for (const storageKey of collectStoredMediaKeys(value)) {
            const namespace = storageKey.startsWith("image:") ? "image_files" : "media_files";
            if (!blobs.has(entryKey(namespace, storageKey))) problems.push(`${label} 缺少媒体 ${storageKey}`);
        }
        for (const ref of binaries) {
            const binaryNamespace = record.namespace === "image_previews" ? "image_previews" : "plugin-binary";
            const blob = blobs.get(entryKey(binaryNamespace, ref.id));
            if (!blob || blob.bytes !== ref.size) problems.push(`${label} 缺少二进制文件 ${ref.id}`);
        }
        return { ...record, value: transformStoredValue(record.value, (value) => sanitizeStoredUrls(value, snapshot.runtimeUrlPrefix)) };
    });
    if (problems.length) throw new Error(`无法完整备份，原数据未修改：\n${problems.join("\n")}`);
    const sort = (a: { namespace: string; key: string }, b: { namespace: string; key: string }) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key);
    return { ...snapshot, records: normalized.sort(sort), blobs: [...snapshot.blobs].sort(sort) };
}

export async function createBrowserBackupTarget(): Promise<BackupTarget> {
    const picker = (globalThis as typeof globalThis & {
        showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array> & { close(): Promise<void>; abort(reason?: unknown): Promise<void> }> }>;
    }).showSaveFilePicker;
    if (!picker) throw new Error("完整备份需要支持本地文件写入的 Chrome 或 Edge，请使用该浏览器打开应用");
    const handle = await picker({ suggestedName: "infinite-canvas-backup.zip", types: [{ description: "完整应用备份", accept: { "application/zip": [".zip"] } }] });
    const writable = await handle.createWritable();
    return { writable, commit: () => writable.close(), abort: (reason) => writable.abort(reason) };
}

export async function exportFullBackup(
    source: BackupSource,
    selectedTarget?: BackupTarget,
    onProgress?: (progress: BackupProgress) => void,
    signal?: AbortSignal,
): Promise<BackupManifest> {
    // Open the picker before awaiting storage locks so the browser user activation is retained.
    const target = selectedTarget || await createBrowserBackupTarget();
    try {
        return await source.withMaintenance(async () => {
            signal?.throwIfAborted();
            onProgress?.({ stage: "preflight", completed: 0, total: 0 });
            const before = await source.fingerprint(signal);
            const snapshot = prepareBackupSnapshot(await source.snapshot(signal));
            const archive = new ZipWriter(target.writable, { zip64: true, bufferedWrite: false, level: 0, useWebWorkers: false, preventClose: true });
            const manifest: BackupManifest = { format: "infinite-canvas-backup", version: 1, records: [], blobs: [], counts: { records: 0, binaries: 0, bytes: 0 } };
            for (const [index, record] of snapshot.records.entries()) {
                signal?.throwIfAborted();
                const content = new Blob([record.value], { type: "application/json" });
                const path = `records/${index}.json`;
                const sha256 = await sha256Blob(content, signal);
                await archive.add(path, new BlobReader(content), { signal });
                const { value: _, ...metadata } = record;
                manifest.records.push({ ...metadata, path, size: content.size, sha256 });
                manifest.counts.bytes += content.size;
                onProgress?.({ stage: "records", completed: index + 1, total: snapshot.records.length });
            }
            for (const [index, binary] of snapshot.blobs.entries()) {
                signal?.throwIfAborted();
                const digest = await createSHA256();
                digest.init();
                let bytes = 0;
                let content: ReadableStream<Uint8Array>;
                if (binary.stream) content = await binary.stream(signal);
                else {
                    const blob = await binary.read(signal);
                    if (!(blob instanceof Blob) || blob.size !== binary.bytes) throw new Error(`媒体在备份期间缺失或变化：${binary.namespace}/${binary.key}`);
                    content = blob.stream();
                }
                const path = `binaries/${index}.bin`;
                const measured = content.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, controller) {
                        signal?.throwIfAborted();
                        bytes += chunk.byteLength;
                        digest.update(chunk);
                        controller.enqueue(chunk);
                    },
                }), { signal });
                await archive.add(path, measured, { signal });
                const sha256 = digest.digest("hex");
                if (bytes !== binary.bytes || binary.sha256 && sha256 !== binary.sha256) throw new Error(`媒体在备份期间缺失或变化：${binary.namespace}/${binary.key}`);
                manifest.blobs.push({ namespace: binary.namespace, key: binary.key, path, mime: binary.mimeType, size: bytes, sha256 });
                manifest.counts.bytes += bytes;
                onProgress?.({ stage: "binaries", completed: index + 1, total: snapshot.blobs.length });
            }
            manifest.counts.records = manifest.records.length;
            manifest.counts.binaries = manifest.blobs.length;
            onProgress?.({ stage: "verify", completed: 0, total: 1 });
            if (before !== await source.fingerprint(signal)) throw new Error("备份期间源数据发生变化，本次导出已取消；请关闭其他应用标签页后重试");
            await archive.add("manifest.json", new BlobReader(new Blob([JSON.stringify(manifest)])), { signal });
            await archive.close();
            signal?.throwIfAborted();
            await target.commit();
            onProgress?.({ stage: "verify", completed: 1, total: 1 });
            return manifest;
        });
    } catch (error) {
        await target.abort(error).catch(() => undefined);
        throw error;
    }
}
