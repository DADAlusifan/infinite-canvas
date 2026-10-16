import { saveFile } from "@/services/desktop/files";

import i18n from "@/i18n";
import { createZip } from "@/lib/zip";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { getDesktopRuntime } from "@/services/desktop/runtime";
import { collectStoredMediaKeys, prepareMediaImport, readTransferZip, sanitizeStoredUrls } from "@/services/storage/transfer";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = i18n.t("canvas.export.defaultProjectName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                [...collectStoredMediaKeys(project)].map(async (storageKey) => {
                    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) throw new Error(`缺少本地媒体，无法导出完整画布：${storageKey}`);
                    const path = `projects/${safeFileName(project.id)}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project: sanitizeStoredUrls(project, getDesktopRuntime()?.apiBase), files };
        }),
    );

    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    await saveFile(zip, `${safeFileName(fileName)}.zip`);
}

export async function readCanvasPackage(file: Blob): Promise<CanvasProject[]> {
    const zip = await readTransferZip(file);
    const manifest = zip.get("projects.json");
    if (!manifest) throw new Error("导入包缺少 projects.json");
    const data = JSON.parse(await manifest.text()) as CanvasExportFile;
    if (data?.app !== "infinite-canvas" || data.version !== 3 || !Array.isArray(data.projects)) throw new Error("画布导入包格式不正确");
    const projectIds = new Set<string>();
    for (const item of data.projects) {
        const project = item?.project;
        const validProject = project && typeof project.id === "string" && !projectIds.has(project.id) && typeof project.title === "string"
            && Array.isArray(project.nodes) && Array.isArray(project.connections) && Array.isArray(project.chatSessions) && Array.isArray(item.files)
            && project.viewport && [project.viewport.x, project.viewport.y, project.viewport.k].every(Number.isFinite) && project.viewport.k > 0;
        if (!validProject) throw new Error("画布项目结构不正确");
        projectIds.add(project.id);
        const nodeIds = new Set<string>();
        for (const node of project.nodes) {
            const validNode = node && typeof node.id === "string" && !nodeIds.has(node.id) && typeof node.type === "string"
                && node.position && [node.position.x, node.position.y, node.width, node.height].every(Number.isFinite);
            if (!validNode) throw new Error("画布节点结构不正确");
            nodeIds.add(node.id);
        }
        if (project.connections.some((connection) => !connection || typeof connection.id !== "string" || !nodeIds.has(connection.fromNodeId) || !nodeIds.has(connection.toNodeId))) throw new Error("画布连线引用不正确");
    }
    const projects = sanitizeStoredUrls(data.projects.map((item) => item.project), getDesktopRuntime()?.apiBase);
    const writes = await prepareMediaImport(projects, data.projects.flatMap((item) => item.files), zip, (key) => key.startsWith("image:") ? getImageBlob(key) : getMediaBlob(key));
    for (const { storageKey, blob } of writes) await (storageKey.startsWith("image:") ? setImageBlob(storageKey, blob) : setMediaBlob(storageKey, blob));
    return projects;
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };

    await Promise.all(
        nodes.map(async (node) => {
            const title = node.title || node.type;
            const storageKey = node.metadata?.storageKey || "";
            if (storageKey) {
                const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                if (blob) return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            if (node.type === CanvasNodeType.Text) return void zipFiles.push({ name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" });
            const content = node.metadata?.content;
            if (content && content.startsWith("data:")) {
                const blob = await (await fetch(content)).blob();
                return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            zipFiles.push({ name: uniqueName(title, "json"), data: JSON.stringify(sanitizeStoredUrls(node, getDesktopRuntime()?.apiBase), null, 2) });
        }),
    );

    const zip = await createZip(zipFiles);
    await saveFile(zip, `${safeFileName(fileName)}.zip`);
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
