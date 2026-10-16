import { inspectStoredValue } from "./codec";
import { binaryNamespace, listDesktopBlobs, listDesktopRecords, type StoredBlob } from "./driver";
import { collectStoredMediaKeys } from "./transfer";

export type MediaReference = { namespace: string; key: string };
const liveReferences = new Set<() => unknown>();

export function registerMediaReferences(read: () => unknown) {
    liveReferences.add(read);
    return () => { liveReferences.delete(read); };
}

export function collectMediaReferences(value: unknown, references = new Map<string, MediaReference>(), seen = new WeakSet<object>()) {
    for (const key of collectStoredMediaKeys(value, new Set(), seen)) {
        const reference = { namespace: key.startsWith("image:") ? "image_files" : "media_files", key };
        references.set(JSON.stringify(reference), reference);
    }
    return references;
}

export async function currentMediaReferences(protect?: StoredBlob[]) {
    const references = new Map<string, MediaReference>();
    const records = await listDesktopRecords();
    for (const record of records) {
        if (record.namespace === "preferences") continue;
        if (record.namespace === "image_previews") continue;
        const graph = inspectStoredValue(record.value);
        for (const ref of graph.binaries) {
            const reference = { namespace: binaryNamespace(record.namespace), key: ref.id };
            references.set(JSON.stringify(reference), reference);
        }
        let value = graph.value;
        if (typeof value === "string") { try { value = JSON.parse(value); } catch { /* Plain plugin strings are valid. */ } }
        collectMediaReferences(value, references);
    }
    for (const read of liveReferences) collectMediaReferences(read(), references);
    for (const record of records.filter((record) => record.namespace === "image_previews")) {
        if (record.key.startsWith("image:") && !references.has(JSON.stringify({ namespace: "image_files", key: record.key }))) continue;
        for (const ref of inspectStoredValue(record.value).binaries) {
            const reference = { namespace: "image_previews", key: ref.id };
            references.set(JSON.stringify(reference), reference);
        }
    }
    if (protect) {
        const approved = new Set(protect.map((blob) => JSON.stringify({ namespace: blob.namespace, key: blob.key })));
        for (const blob of await listDesktopBlobs()) {
            const reference = { namespace: blob.namespace, key: blob.key };
            if (!approved.has(JSON.stringify(reference))) references.set(JSON.stringify(reference), reference);
        }
    }
    return [...references.values()];
}
