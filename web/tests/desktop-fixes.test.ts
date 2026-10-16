import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { startCanvasGenerationRequest, finishCanvasGenerationRequest, stopCanvasGenerationRequests, type CanvasGenerationRequest } from "../src/lib/canvas/generation-requests";
import { getMaintenanceState, subscribeMaintenance, withStorageMaintenance } from "../src/services/storage/maintenance";
import { collectStoredMediaKeys, readTransferZip, sanitizeStoredUrls } from "../src/services/storage/transfer";
import { encodeStoredValue, decodeStoredValue, inspectStoredValue } from "../src/services/storage/codec";
import { prepareBackupSnapshot } from "../src/services/storage/backup";
import { hydrateCanvasImages } from "../src/lib/canvas/canvas-generation-helpers";
import * as images from "../src/services/image-storage";
import * as media from "../src/services/file-storage";
import type { CanvasNodeData } from "../src/types/canvas";

afterEach(() => mock.restore());

test("cancel and late finally release the same generation once, while replacements and batches stay protected", async () => {
    const requests = new Map<string, CanvasGenerationRequest>();
    const baseline = getMaintenanceState().activities;
    const old = startCanvasGenerationRequest(requests, "node", "source", "batch");
    const counts: number[] = [];
    const unsubscribe = subscribeMaintenance(() => counts.push(getMaintenanceState().activities));
    try {
        const current = startCanvasGenerationRequest(requests, "node", "source", "batch");
        expect(old.signal.aborted).toBe(true);
        expect(counts.every((count) => count > baseline)).toBe(true);
        finishCanvasGenerationRequest(requests, "node", old);
        expect(getMaintenanceState().activities).toBe(baseline + 1);
        expect(startCanvasGenerationRequest(requests, "node", "source", "batch", current)).toBe(current);
        expect(getMaintenanceState().activities).toBe(baseline + 1);
        const other = startCanvasGenerationRequest(requests, "other", "source", "batch");
        const unrelated = startCanvasGenerationRequest(requests, "unrelated", "unrelated");
        expect([...stopCanvasGenerationRequests(requests, "batch")].sort()).toEqual(["node", "other", "source"]);
        expect(current.signal.aborted && other.signal.aborted).toBe(true);
        finishCanvasGenerationRequest(requests, "node", current);
        finishCanvasGenerationRequest(requests, "other", other);
        expect(getMaintenanceState().activities).toBe(baseline + 1);
        expect(unrelated.signal.aborted).toBe(false);
        stopCanvasGenerationRequests(requests);
        finishCanvasGenerationRequest(requests, "unrelated", unrelated);
        expect(getMaintenanceState().activities).toBe(baseline);
        await withStorageMaintenance("backup after cancellation", async () => expect(requests.size).toBe(0));
    } finally { stopCanvasGenerationRequests(requests); unsubscribe(); }
});

test("media reference discovery distinguishes text and typed URLs from explicit fields, including shared collections", async () => {
    const shared = ["image:reference", "https://example.test/reference.png", "file:///D:/notes.txt"];
    const value = {
        content: "file:///D:/notes.png", prompt: '{"storageKey":"image:example-in-prompt"}', title: "image:ordinary-title",
        text: "video:ordinary-text", urls: [new URL("file:///D:/notes"), new URL("image:ordinary-url")],
        descriptions: new Set(["image:ordinary-set"]), elsewhere: shared,
        metadata: { references: shared, storageKey: "image:original" },
        plugin: new Map([["references", new Set(["audio:plugin"])] as [string, unknown], ["storageKey", "custom:plugin"]]),
        serialized: JSON.stringify({ storageKey: "video:cached" }),
        mapKeys: new Map([[{ storageKey: "image:map-key" }, "not a reference"]]),
    };
    expect([...collectStoredMediaKeys(value)].sort()).toEqual([
        "audio:plugin", "custom:plugin", "image:map-key", "image:original", "image:reference", "video:cached",
    ]);
    const textOnly = { state: { projects: [{ nodes: [{ type: "text", metadata: { content: "file:///D:/notes.png", prompt: '{"storageKey":"image:example"}' } }] }] }, version: 0 };
    expect(sanitizeStoredUrls({ type: "text", metadata: { content: "blob:an-example-in-a-note" } }).metadata.content).toBe("blob:an-example-in-a-note");
    const encoded = await encodeStoredValue(JSON.stringify(textOnly), async () => { throw new Error("unexpected binary"); });
    const snapshot = prepareBackupSnapshot({ records: [{ namespace: "app_state", key: "canvas", kind: "value", value: encoded }], blobs: [] });
    expect(JSON.parse(await decodeStoredValue<string>(snapshot.records[0].value, async () => { throw new Error("unexpected binary"); }))).toEqual(textOnly);
    const files = await import("../src/services/desktop/files");
    const { exportCanvasProjects } = await import("../src/lib/canvas/canvas-export");
    let saved: Blob | undefined;
    spyOn(files, "saveFile").mockImplementation(async (value) => { saved = value as Blob; });
    const readMedia = spyOn(media, "getMediaBlob").mockImplementation(async () => { throw new Error("text is not a media attachment"); });
    await exportCanvasProjects([{ ...textOnly.state.projects[0], id: "text-only", title: "note" }] as any, "text-only");
    const zip = await readTransferZip(saved!);
    const exported = JSON.parse(await zip.get("projects.json")!.text());
    expect(exported.projects[0].files).toEqual([]);
    expect(exported.projects[0].project.nodes[0].metadata.content).toBe("file:///D:/notes.png");
    expect(readMedia).not.toHaveBeenCalled();
    const required = await encodeStoredValue({ metadata: { references: ["image:missing"] } }, async () => { throw new Error("unexpected binary"); });
    expect(() => prepareBackupSnapshot({ records: [{ namespace: "app_state", key: "canvas", kind: "value", value: required }], blobs: [] })).toThrow("image:missing");
    const fixture = await Bun.file(new URL("./fixtures/desktop-media-references.json", import.meta.url)).text();
    expect([...collectStoredMediaKeys(inspectStoredValue(fixture).value)].sort()).toEqual([
        "audio:required", "custom:required", "image:required", "image:serialized", "video:escaped",
    ]);
});

test("panorama and media plugins restore stable storage keys through persistence and backup round trips", async () => {
    const prefix = "http://127.0.0.1:43210/runtime";
    spyOn(images, "resolveImageUrl").mockImplementation(async (key) => `${prefix}/blob/image_files/${key}`);
    spyOn(images, "ensureImagePreview").mockResolvedValue(undefined);
    spyOn(media, "resolveMediaUrl").mockImplementation(async (key) => `${prefix}/blob/media_files/${key}`);
    const nodes = [
        { id: "panorama", type: "panorama:viewer", metadata: { storageKey: "image:panorama", content: "blob:old" } },
        { id: "image", type: "image", metadata: { storageKey: "image:original", content: "blob:old", images: [{ id: "variant", storageKey: "image:variant", content: "" }] } },
        { id: "video", type: "video", metadata: { storageKey: "video:one", content: "blob:old" } },
        { id: "audio-plugin", type: "plugin:audio", metadata: { storageKey: "audio:one", content: "" } },
        { id: "text-plugin", type: "plugin:text", metadata: { content: "ordinary plugin content" } },
    ] as unknown as CanvasNodeData[];
    const first = await hydrateCanvasImages(sanitizeStoredUrls(nodes));
    expect(first[0].metadata.content).toBe(`${prefix}/blob/image_files/image:panorama`);
    expect(first[1].metadata.images?.[0].content).toBe(`${prefix}/blob/image_files/image:variant`);
    expect(first[2].metadata.content).toBe(`${prefix}/blob/media_files/video:one`);
    expect(first[3].metadata.content).toBe(`${prefix}/blob/media_files/audio:one`);
    expect(first[4]).toEqual(nodes[4]);
    const value = await encodeStoredValue(JSON.stringify({ state: { projects: [{ nodes: first }] }, version: 0 }), async () => { throw new Error("unexpected binary"); });
    const binary = new Blob(["media"]);
    const snapshot = prepareBackupSnapshot({
        runtimeUrlPrefix: prefix,
        records: [{ namespace: "app_state", key: "canvas", kind: "value", value }],
        blobs: [...collectStoredMediaKeys(first)].map((key) => ({ namespace: key.startsWith("image:") ? "image_files" : "media_files", key, mimeType: "", bytes: binary.size, read: async () => binary })),
    });
    const restored = JSON.parse(await decodeStoredValue<string>(snapshot.records[0].value, async () => { throw new Error("unexpected binary"); }));
    expect(restored.state.projects[0].nodes[0].metadata.content).toBe("");
    const second = await hydrateCanvasImages(restored.state.projects[0].nodes);
    expect(second[0].metadata.content).toBe(first[0].metadata.content);
    expect(second[0].metadata.storageKey).toBe("image:panorama");
});
