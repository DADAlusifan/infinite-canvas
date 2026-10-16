import { desktopInvoke } from "./runtime";
import { getMaintenanceLease, withStorageMaintenance } from "@/services/storage/maintenance";

export type DataRootMode = "copy" | "open";
type DataRootTicket = { token: string; dataRoot: string };

/** Keep the old window frozen until the host actually exits, not just until IPC returns. */
export async function restartDesktopToDataRoot(token: string): Promise<never> {
    if (!getMaintenanceLease()) throw new Error("请先保存当前数据并暂停写入，再切换目录");
    await desktopInvoke("desktop_restart_to_import", { token });
    return new Promise<never>(() => {});
}

export async function changeDesktopDataRoot(mode: DataRootMode, label: string): Promise<void> {
    await withStorageMaintenance(label, async () => {
        const ready = await desktopInvoke<DataRootTicket | null>("desktop_change_data_root", {
            mode, lease: getMaintenanceLease(),
        });
        if (!ready) return;
        try {
            await restartDesktopToDataRoot(ready.token);
        } catch (error) {
            // A failed restart must not leave this operation blocking the next attempt.
            await desktopInvoke("desktop_import_cancel");
            throw error;
        }
    });
}
