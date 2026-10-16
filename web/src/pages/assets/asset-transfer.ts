import { saveFile } from "@/services/desktop/files";

import { createZip } from "@/lib/zip";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { getDesktopRuntime } from "@/services/desktop/runtime";
import { collectStoredMediaKeys, prepareMediaImport, readTransferZip, sanitizeStoredUrls } from "@/services/storage/transfer";
import type { Asset } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[], filename: string) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    await Promise.all(
        [...collectStoredMediaKeys(assets)].map(async (storageKey) => {
            const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            if (!blob) throw new Error(`缺少本地媒体，无法导出完整素材包：${storageKey}`);
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey.startsWith("image:") ? "image" : "video")}`;
            files.push({ storageKey, path, mimeType: blob.type, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets: sanitizeStoredUrls(assets, getDesktopRuntime()?.apiBase), files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    await saveFile(zip, filename);
}

export async function readAssetPackage(file: File) {
    const zip = await readTransferZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("导入包缺少 assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    if (data?.app !== "infinite-canvas" || data.version !== 1 || !Array.isArray(data.assets) || !Array.isArray(data.files)) throw new Error("素材导入包格式不正确");
    const ids = new Set<string>();
    for (const asset of data.assets) {
        const validRecord = asset && typeof asset.id === "string" && !ids.has(asset.id) && typeof asset.title === "string" && typeof asset.coverUrl === "string"
            && Array.isArray(asset.tags) && asset.tags.every((tag) => typeof tag === "string") && asset.data && ["image", "video", "text"].includes(asset.kind);
        if (!validRecord) throw new Error("素材记录结构不正确");
        const validContent = asset.kind === "text" ? typeof asset.data.content === "string"
            : [asset.data.width, asset.data.height, asset.data.bytes].every(Number.isFinite) && typeof asset.data.mimeType === "string";
        if (!validContent) throw new Error("素材内容结构不正确");
        ids.add(asset.id);
    }
    const assets = sanitizeStoredUrls(data.assets, getDesktopRuntime()?.apiBase);
    const writes = await prepareMediaImport(assets, data.files, zip, (key) => key.startsWith("image:") ? getImageBlob(key) : getMediaBlob(key));
    for (const { storageKey, blob } of writes) await (storageKey.startsWith("image:") ? setImageBlob(storageKey, blob) : setMediaBlob(storageKey, blob));
    return assets;
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return kind === "image" ? "png" : "bin";
}
