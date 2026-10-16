import { desktopInvoke, initializeDesktop, isDesktop } from "@/services/desktop/runtime";
import { initializePreferences } from "@/services/storage/preferences";

async function start() {
    await initializeDesktop();
    await initializePreferences();
    const { mountApplication } = await import("./app-bootstrap");
    await mountApplication();
}

void start().catch((error) => {
    const container = document.getElementById("root")!;
    const title = document.createElement("h2");
    title.textContent = "应用启动失败，原数据保持不变";
    const detail = document.createElement("p");
    detail.textContent = error instanceof Error ? error.message : "无法读取本地数据";
    const retry = document.createElement("button");
    retry.textContent = "重新加载";
    retry.onclick = () => location.reload();
    container.replaceChildren(title, detail, retry);
    if (isDesktop()) {
        const restore = document.createElement("button");
        restore.textContent = "从完整备份恢复到新目录";
        restore.onclick = async () => {
            restore.disabled = true;
            try {
                await desktopInvoke("desktop_import_cancel");
                const result = await desktopInvoke<{ token: string } | null>("desktop_import_backup");
                if (result) await desktopInvoke("desktop_restart_to_import", { token: result.token });
            } catch (reason) { detail.textContent = reason instanceof Error ? reason.message : String(reason); }
            finally { restore.disabled = false; }
        };
        container.append(restore);
    }
});
