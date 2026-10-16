import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import { isDesktop } from "@/services/desktop/runtime";

export type InstalledPlugin = {
    id: string;
    name: string;
    version: string;
    description?: string;
    url: string; // Installation source used for updates.
    source: string; // Cached plugin source for offline use and pinned versions.
    enabled: boolean;
    local?: boolean; // Local plugin discovered in web/public/plugins; disabled by default and refetched from its URL when enabled.
    official?: boolean; // Installed from the official registry and grouped accordingly in the manager.
    installedAt: string;
};

type PluginStore = {
    plugins: InstalledPlugin[];
    upsert: (plugin: Omit<InstalledPlugin, "installedAt"> & { installedAt?: string }) => void;
    setEnabled: (id: string, enabled: boolean) => void;
    remove: (id: string) => void;
};

export const usePluginStore = create<PluginStore>()(
    persist(
        (set) => ({
            plugins: [],
            upsert: (plugin) =>
                set((state) => {
                    const installedAt = plugin.installedAt || new Date().toISOString();
                    const exists = state.plugins.some((item) => item.id === plugin.id);
                    const next = { ...plugin, installedAt };
                    return { plugins: exists ? state.plugins.map((item) => (item.id === plugin.id ? next : item)) : [next, ...state.plugins] };
                }),
            setEnabled: (id, enabled) => set((state) => ({ plugins: state.plugins.map((item) => (item.id === id ? { ...item, enabled } : item)) })),
            remove: (id) => set((state) => ({ plugins: state.plugins.filter((item) => item.id !== id) })),
        }),
        {
            name: "infinite-canvas:plugin_store",
            storage: createJSONStorage(() => localForageStorage),
            skipHydration: isDesktop(),
            merge: (persisted, current) => {
                if (persisted === undefined) return current;
                const value = persisted as Partial<PluginStore>;
                if (!Array.isArray(value.plugins) || value.plugins.some((plugin) => !plugin || typeof plugin.id !== "string" || typeof plugin.source !== "string")) throw new Error("插件记录损坏，已保留原数据");
                return { ...current, plugins: value.plugins };
            },
        },
    ),
);
