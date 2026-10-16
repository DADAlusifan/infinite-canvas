import { createStorage } from "@/services/storage/driver";
import { preferences } from "@/services/storage/preferences";
import { isDesktop } from "@/services/desktop/runtime";
import type { StateStorage } from "zustand/middleware";

const store = createStorage("app_state");

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await store.getItem<string>(name)) ?? null;
        } catch (error) {
            if (isDesktop()) throw error;
            return preferences.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await store.setItem(name, value);
        } catch (error) {
            if (isDesktop()) throw error;
            await preferences.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await store.removeItem(name);
        } catch (error) {
            if (isDesktop()) throw error;
            await preferences.removeItem(name);
        }
    },
};
