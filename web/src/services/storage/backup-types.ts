export type BackupRecordSource = { namespace: string; key: string; value: string; kind: "value" | "preference" };
export type BackupBlobSource = {
    namespace: string;
    key: string;
    mimeType: string;
    bytes: number;
    sha256?: string;
    stream?: (signal?: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
    read: (signal?: AbortSignal) => Promise<Blob>;
};
export type BackupSnapshot = { records: BackupRecordSource[]; blobs: BackupBlobSource[]; runtimeUrlPrefix?: string };
export interface BackupSource {
    snapshot(signal?: AbortSignal): Promise<BackupSnapshot>;
    fingerprint(signal?: AbortSignal): Promise<string>;
    withMaintenance<T>(work: () => Promise<T>): Promise<T>;
}
export interface BackupTarget {
    writable: WritableStream<Uint8Array>;
    commit(): Promise<void>;
    abort(reason: unknown): Promise<void>;
}
export type BackupProgress = { stage: "preflight" | "records" | "binaries" | "verify"; completed: number; total: number };
export type BackupRecord = Omit<BackupRecordSource, "value"> & { path: string; size: number; sha256: string };
export type BackupBinary = { namespace: string; key: string; path: string; mime: string; size: number; sha256: string };
export type BackupManifest = {
    format: "infinite-canvas-backup";
    version: 1;
    records: BackupRecord[];
    blobs: BackupBinary[];
    counts: { records: number; binaries: number; bytes: number };
};
