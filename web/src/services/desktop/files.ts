import { saveAs } from "file-saver";
import { desktopInvoke, isDesktop, desktopProxyUrl } from "./runtime";
import type { BackupTarget } from "@/services/storage/backup-types";
import { startStorageActivity } from "@/services/storage/maintenance";

export async function createDesktopSaveTarget(defaultName: string): Promise<BackupTarget | null> {
    const ticket = await desktopInvoke<{ id: string; uploadUrl: string } | null>("desktop_save_begin", { defaultName });
    if (!ticket) return null;
    const controller = new AbortController();
    let offset = 0;
    const writable = new WritableStream<Uint8Array>({
        async write(chunk) {
            const response = await fetch(ticket.uploadUrl, { method: "PUT", headers: { "x-desktop-offset": String(offset) }, body: new Blob([chunk]), signal: controller.signal });
            if (!response.ok) throw new Error("无法写入所选文件，原文件保持不变");
            offset += chunk.byteLength;
        },
    });
    return {
        writable,
        async commit() {
            const writer = writable.getWriter();
            try { await writer.close(); } finally { writer.releaseLock(); }
            await desktopInvoke("desktop_save_finish", { id: ticket.id });
        },
        async abort(reason) {
            controller.abort(reason);
            await writable.abort(reason).catch(() => undefined);
            await desktopInvoke("desktop_save_cancel", { id: ticket.id });
        },
    };
}

export async function saveFile(data: Blob | string, filename: string) {
    if (!isDesktop()) { saveAs(data, filename); return; }
    const target = await createDesktopSaveTarget(filename);
    if (!target) return;
    let finish: (() => void) | undefined;
    try {
        finish = startStorageActivity();
        const source = typeof data === "string" ? await fetch(desktopProxyUrl(data)) : new Response(data);
        if (!source.ok || !source.body) throw new Error("下载文件失败");
        await source.body.pipeTo(target.writable, { preventClose: true });
        await target.commit();
    } catch (error) { await target.abort(error).catch(() => undefined); throw error; }
    finally { finish?.(); }
}

export async function openExternal(url: string) {
    if (isDesktop()) await desktopInvoke("desktop_open_external", { url });
    else window.open(url, "_blank", "noopener,noreferrer");
}
