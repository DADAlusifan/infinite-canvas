import { isDesktop } from "@/services/desktop/runtime";
import { getMaintenanceState, queueStorageWrite } from "./maintenance";
import { listDesktopRecords, writeDesktopRecords } from "./driver";

const cache = new Map<string, string>();
const revisions = new Map<string, number>();
const extraKeys = new Set(["canvas-agent-url", "canvas-agent-token", "canvas-agent-model", "canvas-agent-reasoning-effort", "canvas-agent-permission-mode", "canvas-agent-panel-width", "canvas-side-panel-width", "canvas-side-panel-open", "canvas-side-panel-node-view", "canvas-image-quick-tools-v7"]);
export const isApplicationPreference = (key: string) => key.startsWith("infinite-canvas:") || extraKeys.has(key);

export async function initializePreferences() {
    if (!isDesktop()) return;
    const records = await listDesktopRecords("preferences");
    cache.clear();
    records.forEach(({ key, value }) => cache.set(key, value));
}

export const preferences = {
    getItem(key: string) {
        if (isDesktop()) return cache.get(key) ?? null;
        return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    },
    setItem(key: string, value: string) {
        if (getMaintenanceState().busy) throw new Error("数据维护中，设置暂时不可修改");
        const previous = cache.get(key), revision = (revisions.get(key) || 0) + 1;
        revisions.set(key, revision);
        if (isDesktop()) cache.set(key, value);
        const result = queueStorageWrite(async () => {
            if (isDesktop()) {
                await writeDesktopRecords([{ op: "set", namespace: "preferences", key, value }]);
                if (revisions.get(key) === revision) cache.set(key, value);
            }
            else if (typeof window !== "undefined") window.localStorage.setItem(key, value);
        });
        void result.catch(() => { if (isDesktop() && revisions.get(key) === revision) previous === undefined ? cache.delete(key) : cache.set(key, previous); });
        return result;
    },
    removeItem(key: string) {
        if (getMaintenanceState().busy) throw new Error("数据维护中，设置暂时不可修改");
        const previous = cache.get(key), revision = (revisions.get(key) || 0) + 1;
        revisions.set(key, revision);
        if (isDesktop()) cache.delete(key);
        const result = queueStorageWrite(async () => {
            if (isDesktop()) {
                await writeDesktopRecords([{ op: "remove", namespace: "preferences", key }]);
                if (revisions.get(key) === revision) cache.delete(key);
            }
            else if (typeof window !== "undefined") window.localStorage.removeItem(key);
        });
        void result.catch(() => { if (isDesktop() && revisions.get(key) === revision && previous !== undefined) cache.set(key, previous); });
        return result;
    },
};

export function applicationPreferences() {
    if (isDesktop()) return Object.fromEntries(cache);
    if (typeof window === "undefined") return {} as Record<string, string>;
    return Object.fromEntries(Object.keys(window.localStorage).filter(isApplicationPreference).map((key) => [key, window.localStorage.getItem(key)!]));
}

/** Used by validated configuration import while the application holds its maintenance lock. */
export async function commitPreferenceBatch(values: Record<string, string>) {
    if (!getMaintenanceState().busy) throw new Error("配置批量写入需要先暂停其他写入");
    if (isDesktop()) {
        await writeDesktopRecords(Object.entries(values).map(([key, value]) => ({ op: "set", namespace: "preferences", key, value })));
        Object.entries(values).forEach(([key, value]) => cache.set(key, value));
        return;
    }
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, window.localStorage.getItem(key)]));
    try { Object.entries(values).forEach(([key, value]) => window.localStorage.setItem(key, value)); }
    catch (error) {
        Object.entries(previous).forEach(([key, value]) => value === null ? window.localStorage.removeItem(key) : window.localStorage.setItem(key, value));
        throw error;
    }
}
