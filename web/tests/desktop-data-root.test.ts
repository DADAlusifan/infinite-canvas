import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as runtime from "../src/services/desktop/runtime";
import * as maintenance from "../src/services/storage/maintenance";
import { changeDesktopDataRoot, restartDesktopToDataRoot } from "../src/services/desktop/data-root";

afterEach(() => mock.restore());

let caseId = 0;
async function setup(handle: (command: string) => unknown = () => null) {
    const service = await import(`../src/services/storage/maintenance.ts?directory=${caseId++}`) as typeof maintenance;
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    spyOn(maintenance, "withStorageMaintenance").mockImplementation(service.withStorageMaintenance);
    spyOn(maintenance, "getMaintenanceLease").mockImplementation(service.getMaintenanceLease);
    spyOn(runtime, "isDesktop").mockReturnValue(true);
    spyOn(runtime, "desktopInvoke").mockImplementation(async (command, args) => {
        calls.push({ command, args });
        return (command === "desktop_maintenance_begin" ? { token: "directory-lease" } : await handle(command)) as any;
    });
    return { service, calls };
}

test("directory selection saves the latest canvas first; cancel releases the lease without restarting", async () => {
    const { service, calls } = await setup();
    let viewport = "old";
    let saved = "";
    service.registerStorageFlusher(() => { viewport = "latest"; }, -100);
    service.registerStorageFlusher(() => service.queueStorageWrite(async () => { saved = viewport; }));
    await changeDesktopDataRoot("copy", "change folder");
    expect(saved).toBe("latest");
    expect(calls).toEqual([
        { command: "desktop_storage_flush", args: undefined },
        { command: "desktop_maintenance_begin", args: undefined },
        { command: "desktop_change_data_root", args: { mode: "copy", lease: "directory-lease" } },
        { command: "desktop_maintenance_end", args: { token: "directory-lease" } },
    ]);
    expect(service.getMaintenanceState().busy).toBe(false);
    await service.queueStorageWrite(async () => { saved = "editable"; });
    expect(saved).toBe("editable");
});

test("active work, failed saves, and failed directory validation never request a restart", async () => {
    const { service, calls } = await setup((command) => {
        if (command === "desktop_change_data_root") throw new Error("target media missing");
    });
    const finish = service.startStorageActivity();
    await expect(changeDesktopDataRoot("open", "switch")).rejects.toThrow("等待生成");
    expect(calls).toHaveLength(0);
    finish();
    const unregister = service.registerStorageFlusher(() => { throw new Error("save failed"); });
    await expect(changeDesktopDataRoot("open", "switch")).rejects.toThrow("save failed");
    expect(calls).toHaveLength(0);
    unregister();
    await expect(changeDesktopDataRoot("open", "switch")).rejects.toThrow("target media missing");
    expect(calls.map(({ command }) => command)).toEqual([
        "desktop_storage_flush", "desktop_maintenance_begin", "desktop_change_data_root", "desktop_maintenance_end",
    ]);
    expect(service.getMaintenanceState().busy).toBe(false);
    await expect(restartDesktopToDataRoot("unprepared")).rejects.toThrow("暂停写入");
});

test("a failed restart discards only the newly prepared switch and restores editing", async () => {
    const { service, calls } = await setup((command) => {
        if (command === "desktop_change_data_root") return { token: "prepared", dataRoot: "D:/new" };
        if (command === "desktop_restart_to_import") throw new Error("locator write failed");
    });
    await expect(changeDesktopDataRoot("open", "switch")).rejects.toThrow("locator write failed");
    expect(calls.slice(-3).map(({ command }) => command)).toEqual([
        "desktop_restart_to_import", "desktop_import_cancel", "desktop_maintenance_end",
    ]);
    expect(service.getMaintenanceState().busy).toBe(false);
    await service.queueStorageWrite(async () => {});
});

test("successful directory copy keeps edits and new tasks frozen until the host exits", async () => {
    let restarting!: () => void;
    const requested = new Promise<void>((resolve) => { restarting = resolve; });
    const { service, calls } = await setup((command) => {
        if (command === "desktop_change_data_root") return { token: "copied", dataRoot: "D:/copy" };
        if (command === "desktop_restart_to_import") restarting();
    });
    let finished = false;
    void changeDesktopDataRoot("copy", "copy").then(() => { finished = true; });
    await requested;
    await Promise.resolve();
    expect(service.getMaintenanceState().busy).toBe(true);
    expect(service.getMaintenanceLease()).toBe("directory-lease");
    expect(finished).toBe(false);
    expect(calls.at(-1)).toEqual({ command: "desktop_restart_to_import", args: { token: "copied" } });
    await expect(service.queueStorageWrite(async () => {})).rejects.toThrow("写入已暂停");
    expect(() => service.startStorageActivity()).toThrow("维护中");
    await expect(changeDesktopDataRoot("open", "switch")).rejects.toThrow("数据维护尚未完成");
});
