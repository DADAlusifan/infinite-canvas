import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js";
import * as desktop from "../src/services/desktop/runtime";
import * as driver from "../src/services/storage/driver";
import { applicationBackupSource } from "../src/services/storage/backup-source";
import { exportFullBackup } from "../src/services/storage/backup";
import { sha256Blob, sha256Stream } from "../src/services/storage/transfer";
import type { BackupBlobSource, BackupSource, BackupTarget } from "../src/services/storage/backup-types";

afterEach(() => mock.restore());

function outputTarget() {
    const chunks: Uint8Array[] = [];
    let committed = false;
    let aborted = false;
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { chunks.push(chunk.slice()); } });
    const target: BackupTarget = {
        writable,
        async commit() { await writable.close(); committed = true; },
        async abort(reason) { aborted = true; await writable.abort(reason); },
    };
    return { target, bytes: () => new Blob(chunks), committed: () => committed, aborted: () => aborted };
}

function source(binary: BackupBlobSource): BackupSource {
    return { snapshot: async () => ({ records: [], blobs: [binary] }), fingerprint: async () => "unchanged", withMaintenance: (work) => work() };
}

test("ZIP64 export streams native binary chunks directly and hashes the bytes actually written", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6])];
    const expected = await sha256Blob(new Blob(chunks));
    let reads = 0;
    let pulls = 0;
    const binary: BackupBlobSource = {
        namespace: "media_files", key: "video:stream", mimeType: "video/mp4", bytes: 6, sha256: expected,
        read: async () => { reads += 1; throw new Error("whole-file reads are forbidden"); },
        stream: async () => new ReadableStream<Uint8Array>({ pull(controller) {
            if (pulls < chunks.length) controller.enqueue(chunks[pulls++]);
            else controller.close();
        } }),
    };
    const output = outputTarget();
    const manifest = await exportFullBackup(source(binary), output.target);
    expect(reads).toBe(0);
    expect(pulls).toBe(3);
    expect(output.committed()).toBe(true);
    expect(manifest.blobs[0]).toMatchObject({ size: 6, sha256: expected, mime: "video/mp4" });
    const archive = new ZipReader(new BlobReader(output.bytes()), { useWebWorkers: false });
    try {
        const entry = (await archive.getEntries()).find((entry) => entry.filename === manifest.blobs[0].path);
        if (!entry || entry.directory) throw new Error("binary missing");
        expect([...new Uint8Array(await (await entry.getData(new BlobWriter())).arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
    } finally { await archive.close(); }
});

test("streamed size and digest mismatches abort the destination without committing", async () => {
    const bytes = new Blob(["actual bytes"]);
    const digest = await sha256Blob(bytes);
    for (const invalid of [{ bytes: bytes.size + 1, sha256: digest }, { bytes: bytes.size, sha256: "0".repeat(64) }]) {
        const output = outputTarget();
        await expect(exportFullBackup(source({
            namespace: "media_files", key: "video:corrupt", mimeType: "video/mp4", ...invalid,
            read: async () => { throw new Error("whole-file reads are forbidden"); }, stream: async () => bytes.stream(),
        }), output.target)).rejects.toThrow("媒体在备份期间缺失或变化");
        expect(output.committed()).toBe(false);
        expect(output.aborted()).toBe(true);
    }
});

test("native fingerprints use response streams and preserve cancellation across snapshots and reads", async () => {
    const payload = new Blob(["streamed media"]);
    const digest = await sha256Blob(payload);
    spyOn(desktop, "isDesktop").mockReturnValue(true);
    spyOn(desktop, "getDesktopRuntime").mockReturnValue({ dataRoot: "test", apiBase: "http://127.0.0.1/test", network: { mode: "direct", url: "" }, networkError: null });
    spyOn(desktop, "desktopBlobUrl").mockReturnValue("http://127.0.0.1/test/media");
    spyOn(driver, "listDesktopRecords").mockResolvedValue([]);
    spyOn(driver, "listDesktopBlobs").mockResolvedValue([{ namespace: "media_files", key: "video:one", mime: "video/mp4", size: payload.size, sha256: digest }]);
    const wholeFileRead = spyOn(driver, "readDesktopBlob").mockImplementation(async () => { throw new Error("unexpected whole-file read"); });
    const receivedSignals: Array<AbortSignal | null | undefined> = [];
    spyOn(globalThis, "fetch").mockImplementation(async (_input, options) => {
        receivedSignals.push(options?.signal);
        const response = new Response(payload.stream());
        spyOn(response, "blob").mockImplementation(async () => { throw new Error("response.blob must not be called"); });
        return response;
    });
    const signal = new AbortController().signal;
    const snapshot = await applicationBackupSource.snapshot(signal);
    expect(snapshot.blobs[0].stream).toBeFunction();
    expect(snapshot.blobs[0].sha256).toBe(digest);
    expect(await applicationBackupSource.fingerprint(signal)).toMatch(/^[a-f0-9]{64}$/);
    expect(receivedSignals).toEqual([signal]);
    expect(wholeFileRead).not.toHaveBeenCalled();
    await expect(applicationBackupSource.snapshot(AbortSignal.abort())).rejects.toThrow();
    await expect(applicationBackupSource.fingerprint(AbortSignal.abort())).rejects.toThrow();
    expect(receivedSignals).toHaveLength(1);
});

test("canceling a stream hash interrupts a pending read and cancels its source", async () => {
    const abort = new AbortController();
    let canceled = false;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const stream = new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel() { canceled = true; } });
    const result = sha256Stream(stream, abort.signal);
    await started;
    abort.abort(new DOMException("Canceled", "AbortError"));
    await expect(result).rejects.toThrow("Canceled");
    expect(canceled).toBe(true);
});

test("canceling a streamed ZIP entry cancels its source and leaves no committed backup", async () => {
    const abort = new AbortController();
    const output = outputTarget();
    let canceled = false;
    let didEmit = false;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const binary: BackupBlobSource = {
        namespace: "media_files", key: "video:cancel", mimeType: "video/mp4", bytes: 10,
        read: async () => { throw new Error("unexpected whole-file read"); },
        stream: async (signal) => {
            expect(signal).toBe(abort.signal);
            return new ReadableStream<Uint8Array>({
                pull(controller) { if (!didEmit) { controller.enqueue(new Uint8Array([1])); didEmit = true; } else reading(); },
                cancel() { canceled = true; },
            });
        },
    };
    const result = exportFullBackup(source(binary), output.target, undefined, abort.signal);
    await started;
    abort.abort();
    await expect(result).rejects.toThrow();
    expect(canceled).toBe(true);
    expect(output.aborted()).toBe(true);
    expect(output.committed()).toBe(false);
});
