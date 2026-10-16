import { useEffect, useRef, useSyncExternalStore } from "react";
import { App } from "antd";
import { getDesktopRuntime, isDesktop } from "@/services/desktop/runtime";
import { getMaintenanceState, registerMaintenanceBlocker, subscribeMaintenance, withStorageShutdown } from "@/services/storage/maintenance";
import { useAgentStore } from "@/stores/use-agent-store";
import { agentIsBusy } from "@/lib/agent/agent-engine";

export function DesktopLifecycle() {
    const { message, modal } = App.useApp();
    const maintenance = useSyncExternalStore(subscribeMaintenance, getMaintenanceState);
    const closing = useRef(false);
    const allowClose = useRef(false);

    useEffect(() => registerMaintenanceBlocker(() => {
        const agent = useAgentStore.getState();
        return agentIsBusy(agent);
    }), []);

    useEffect(() => {
        if (!maintenance.busy) return;
        const block = (event: Event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-storage-maintenance-controls], .ant-modal-confirm")) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        for (const name of ["pointerdown", "keydown", "drop", "paste"]) document.addEventListener(name, block, true);
        return () => { for (const name of ["pointerdown", "keydown", "drop", "paste"]) document.removeEventListener(name, block, true); };
    }, [maintenance.busy]);

    useEffect(() => {
        if (!isDesktop()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
            const window = getCurrentWindow();
            const stop = await window.onCloseRequested(async (event) => {
                if (allowClose.current) return;
                event.preventDefault();
                if (closing.current) return;
                if (getMaintenanceState().busy) { message.warning("数据维护尚未完成，请先完成或取消操作"); return; }
                closing.current = true;
                const agent = useAgentStore.getState();
                const active = getMaintenanceState().activities || agentIsBusy(agent);
                try {
                    if (active) {
                        const confirmed = await modal.confirm({ title: "退出应用？", content: "仍有生成或对话正在进行。退出会停止本地等待，已有任务信息会保存；重启不会自动重新提交生成。", okText: "保存并退出", cancelText: "继续等待" });
                        if (!confirmed) return;
                    }
                    await withStorageShutdown("正在保存并退出", async () => {
                        allowClose.current = true;
                        await window.close();
                    });
                } catch (error) { allowClose.current = false; message.error(error instanceof Error ? error.message : "保存失败，请重试后退出"); }
                finally { closing.current = false; }
            });
            if (disposed) stop(); else unlisten = stop;
        }).catch((error) => message.error(String(error)));
        const networkError = getDesktopRuntime()?.networkError;
        if (networkError) message.warning(networkError);
        return () => { disposed = true; unlisten?.(); };
    }, [message, modal]);

    return null;
}
