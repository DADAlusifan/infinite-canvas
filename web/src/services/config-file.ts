import { saveFile } from "@/services/desktop/files";

import i18n from "@/i18n";
import { defaultConfig, defaultWebdavSyncConfig, normalizeChannelModels, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";
import { getDesktopRuntime } from "@/services/desktop/runtime";
import { sanitizeStoredUrls } from "@/services/storage/transfer";
import { commitPreferenceBatch } from "@/services/storage/preferences";
import { withStorageMaintenance } from "@/services/storage/maintenance";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export async function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = sanitizeStoredUrls({ app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav, promptSources: { sources, schedule } }, getDesktopRuntime()?.apiBase);
    await saveFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    const invalid = () => { throw new Error(i18n.t("config.invalidFile")); };
    if (data?.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !data.promptSources) invalid();
    const validConfig = Object.entries(defaultConfig).every(([key, value]) => Array.isArray(value)
        ? Array.isArray(data.config[key as keyof AiConfig]) : typeof data.config[key as keyof AiConfig] === typeof value);
    if (!validConfig) invalid();
    if (!Object.keys(defaultWebdavSyncConfig).every((key) => typeof data.webdav[key as keyof WebdavSyncConfig] === "string") || data.config.models.some((model) => typeof model !== "string")) invalid();
    const channelsSeen = new Set<string>();
    for (const channel of data.config.channels) {
        const validChannel = channel && typeof channel.id === "string" && !channelsSeen.has(channel.id) && typeof channel.name === "string"
            && typeof channel.baseUrl === "string" && typeof channel.apiKey === "string" && ["openai", "gemini"].includes(channel.apiFormat) && Array.isArray(channel.models);
        if (!validChannel) invalid();
        const validModels = channel.models.every((model) => typeof model === "string" || (model && typeof model.name === "string"
            && ["image", "video", "text", "audio"].includes(model.capability) && (model.script === undefined || typeof model.script === "string")));
        if (!validModels) invalid();
        channelsSeen.add(channel.id);
    }
    const validSources = Array.isArray(data.promptSources.sources) && data.promptSources.sources.every((source) => source
        && [source.id, source.name, source.url, source.homepage].every((value) => typeof value === "string") && typeof source.enabled === "boolean" && typeof source.builtIn === "boolean");
    const validSchedule = data.promptSources.schedule && Number.isFinite(data.promptSources.schedule.intervalMinutes) && typeof data.promptSources.schedule.lastFetchedAt === "string";
    if (!validSources || !validSchedule) invalid();
    // Validate every model before changing either store, so a bad size list cannot partially import settings.
    const channels = data.config.channels.map((channel) => ({ ...channel, models: normalizeChannelModels(channel.models) }));
    const configState = { config: { ...data.config, channels }, webdav: data.webdav };
    await withStorageMaintenance("正在导入配置", async () => {
        const configOptions = useConfigStore.persist.getOptions();
        const promptOptions = usePromptSourceStore.persist.getOptions();
        await commitPreferenceBatch({
            [configOptions.name]: JSON.stringify({ state: configState, version: configOptions.version || 0 }),
            [promptOptions.name]: JSON.stringify({ state: data.promptSources, version: promptOptions.version || 0 }),
        });
        // Both persisted records committed together; update live state without a second write.
        const silentStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
        useConfigStore.persist.setOptions({ storage: silentStorage });
        usePromptSourceStore.persist.setOptions({ storage: silentStorage });
        try {
            useConfigStore.setState(configState);
            usePromptSourceStore.setState(data.promptSources);
        } finally {
            useConfigStore.persist.setOptions({ storage: configOptions.storage });
            usePromptSourceStore.persist.setOptions({ storage: promptOptions.storage });
        }
    });
}
