import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { isDesktop } from "@/services/desktop/runtime";
import { listDesktopRecords } from "@/services/storage/driver";
import { inspectStoredValue } from "@/services/storage/codec";

const persistedStateKeys = new Map([
    ["infinite-canvas:canvas_store", "projects"],
    ["infinite-canvas:asset_store", "assets"],
    ["infinite-canvas:plugin_store", "plugins"],
    ["infinite-canvas:ai_config_store", "config"],
    ["infinite-canvas:theme_store", "theme"],
    ["infinite-canvas:prompt_source_store_v2", "sources"],
]);

/** Validate persisted records before importing stores, which may otherwise hydrate defaults. */
export async function validateDesktopPersistence() {
    for (const record of await listDesktopRecords()) {
        const value = record.namespace === "preferences" ? record.value : inspectStoredValue(record.value).value;
        const field = persistedStateKeys.get(record.key);
        if (!field || !["app_state", "preferences"].includes(record.namespace)) continue;
        const fail = () => { throw new Error(`本地数据损坏或版本未知，已阻止覆盖：${record.key}`); };
        if (typeof value !== "string") fail();
        let persisted: any;
        try { persisted = JSON.parse(value as string); } catch { fail(); }
        if (!persisted || persisted.version !== 0 || !persisted.state || typeof persisted.state !== "object") fail();
        const state = persisted.state;
        if (["projects", "assets", "plugins", "sources"].includes(field) && !Array.isArray(state[field])) fail();
        if (field === "projects" && !Array.isArray(state.deletedProjects)) fail();
        if (field === "config" && (!state.config || !Array.isArray(state.config.channels) || !state.webdav)) fail();
        if (field === "theme" && !["light", "dark"].includes(state.theme)) fail();
        if (field === "sources" && (!state.schedule || typeof state.schedule.intervalMinutes !== "number")) fail();
    }
}

export async function hydrateDesktopStores() {
    await validateDesktopPersistence();
    const [{ useCanvasStore }, { useAssetStore }, { usePluginStore }, { useConfigStore }, { useThemeStore }, { usePromptSourceStore }] = await Promise.all([
        import("@/stores/canvas/use-canvas-store"), import("@/stores/use-asset-store"), import("@/stores/canvas/use-plugin-store"),
        import("@/stores/use-config-store"), import("@/stores/use-theme-store"), import("@/stores/use-prompt-source-store"),
    ]);
    const stores = [useCanvasStore, useAssetStore, usePluginStore, useConfigStore, useThemeStore, usePromptSourceStore];
    await Promise.all(stores.map((store) => store.persist.hasHydrated() ? undefined : store.persist.rehydrate()));
    if (stores.some((store) => !store.persist.hasHydrated())) throw new Error("本地数据读取失败，已阻止空数据覆盖");
    const { ensureImagePreview } = await import("@/services/image-storage");
    for (const asset of useAssetStore.getState().assets) {
        if (asset.kind === "image" && asset.data.storageKey) void ensureImagePreview(asset.data.storageKey).catch(() => undefined);
    }
}

export async function mountApplication() {
    if (isDesktop()) await hydrateDesktopStores();
    else initAnalytics();

    // Plugin effects and background queries can only mount after every required store succeeded.
    const [{ AppProviders }, { router }] = await Promise.all([
        import("@/components/layout/app-providers"), import("@/router"),
    ]);
    document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders><RouterProvider router={router} /></AppProviders>
        </React.StrictMode>,
    );
}
