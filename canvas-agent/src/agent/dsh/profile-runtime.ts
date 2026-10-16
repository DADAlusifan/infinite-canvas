import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { INSTALL_ANCHOR } from "@deepseek-ai/dsh/profile-boot";
import {
    boot, bundlePatchPaths, composeEntries, createRuntimeResolution, evaluatePluginCompatibility,
    initProfile, installFailLoud, loadOptionalPatches, loadOverlayPatches, PluginPackages,
    pluginCompatibilityWarning, prepareProfilePatches, PROFILE_PATCH_FILENAME, PROFILE_TEMPLATES,
    readProfileManifest, readProfilePatches, readProfileVersionExemptions, resolveBundleDir,
    resolveProfileDir, type Profile, type ProfileContext, type ProfileLayer,
} from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installProxyFromEnvironment } from "@deepseek-ai/dsh-http-proxy";
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";

export type DshProfile = "web" | "desktop";
type Patches = ReturnType<typeof loadOverlayPatches>;
type Entry = ReturnType<typeof composeEntries>[number];
class ProfileCompatibilityError extends Error {}

function loadBundle(packageName: string, dir: string, exemptions: Record<string, string[]>): ProfileLayer {
    const packageDir = resolveBundleDir("dsh", packageName, INSTALL_ANCHOR, dir);
    const manifest = readProfileManifest("dsh", packageDir);
    if (!manifest.dsh?.bundle) throw new Error(`DSH 插件没有 bundle 声明：${packageName}`);
    const issue = evaluatePluginCompatibility(manifest, exemptions);
    if (issue && !issue.exempted) throw new ProfileCompatibilityError(pluginCompatibilityWarning(issue));
    const patchPaths = bundlePatchPaths(packageDir, manifest.dsh.bundle);
    return { packageName, packageDir, patchPaths, patches: patchPaths.flatMap((file) => loadOverlayPatches("dsh", file)) };
}

// The native named-profile loader normalizes manifests and removes old links. Reading a
// source for this embedding must not perform those mutations or rewrite its cordis.yml.
function readSourceProfile(name: DshProfile, home: string): Profile {
    const dir = resolveProfileDir(name, home);
    if (!existsSync(path.join(dir, "package.json"))) {
        if (name === "desktop") throw new Error("DSH Desktop 配置不存在，请先在 DSH Desktop 中完成配置");
        initProfile(dir, PROFILE_TEMPLATES.web!.bundles);
    }
    const manifest = readProfileManifest("dsh", dir);
    const exemptions = readProfileVersionExemptions(dir);
    const profile: Profile = { name, dir, patchPath: path.join(dir, PROFILE_PATCH_FILENAME), patches: [], layers: [], skippedBundles: [] };
    for (const packageName of manifest.dsh?.profile?.bundles ?? []) {
        try { profile.layers.push(loadBundle(packageName, dir, exemptions)); }
        catch (error) {
            const detail = error instanceof ProfileCompatibilityError ? `；${error.message}` : "，请检查该配置来源的插件安装和 bundle 声明";
            throw new Error(`DSH ${name} 配置插件加载失败：${packageName}${detail}`, { cause: error });
        }
    }
    profile.patches = loadOptionalPatches("dsh", profile.patchPath) ?? [];
    return profile;
}

function flatten(entries: Entry[]): Entry[] {
    return entries.flatMap((entry) => [entry, ...(entry.group && Array.isArray(entry.config) ? flatten(entry.config) : [])]);
}

function surfaceOverlay(profile: Profile, home: string, web: ProfileLayer, overlay: Patches): Patches {
    const native = composeEntries([...profile.layers.map((layer) => layer.patches), profile.patches, loadOptionalPatches("dsh", path.join(home, PROFILE_PATCH_FILENAME)) ?? []]);
    const entries = flatten(native);
    const ids = new Set(entries.map((entry) => entry.id));
    const webEntries = composeEntries([web.patches]);
    const missing = webEntries.filter((entry) => !ids.has(entry.id));
    const privateHostIds = new Set(["web-startup", "webserver", "web-runtime", "connection", "modules", "client-hmr"]);
    const patches: Patches = [
        ...(missing.length ? [{ insert: missing }] : []),
        ...webEntries.filter((entry) => privateHostIds.has(entry.id) && ids.has(entry.id)).map((entry) => ({ ...entry, disabled: false })),
    ];
    const desktopIds = new Set(["desktop-runtime", "desktop-startup", "desktop-app", "electron", "electron-runtime", "desktop-updater", "desktop-protocol", "desktop-window", "ui-sidebar-browser"]);
    const desktopModules = ["electron", "@deepseek-ai/dsh-desktop", "@deepseek-ai/dsh-desktop-app", "@deepseek-ai/dsh-desktop-runtime", "@deepseek-ai/dsh-desktop-startup", "@deepseek-ai/dsh-host-desktop", "@deepseek-ai/dsh-client-desktop", "@deepseek-ai/dsh-client-ui-sidebar-browser"];
    for (const entry of entries) {
        const desktopSurface = desktopIds.has(entry.id) || desktopModules.some((name) => entry.name === name || entry.name?.startsWith(`${name}/`));
        if (desktopSurface) patches.push({ id: entry.id, disabled: true });
    }
    return [...patches, ...overlay];
}

/** Official composition and runtime resolution, with only the include root owned by Canvas. */
export async function startDshWebHost(input: { profile: DshProfile; temporary: string; environment: LaunchEnvironmentSnapshot; patch: string }) {
    const home = resolveDshHome();
    const source = readSourceProfile(input.profile, home);
    const web = loadBundle("@deepseek-ai/dsh-web-app", source.dir, {});
    const overlay = loadOverlayPatches("dsh", input.patch);
    const profileContext: ProfileContext = {
        name: input.profile, dir: source.dir, patchPath: source.patchPath, installAnchor: INSTALL_ANCHOR,
        startedBundles: source.layers.map((layer) => layer.packageName), cwd: process.cwd(), home,
        // Native settings edits and HMR recompose through the same privacy/surface overlay.
        get overlays() { return surfaceOverlay(readSourceProfile(input.profile, home), home, web, overlay); },
        telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    };
    const root = path.join(input.temporary, "cordis.yml");
    await fs.writeFile(root, "[]\n");
    const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile: source, home });
    const releaseProxy = await installProxyFromEnvironment(input.environment, (message) => process.stderr.write(`dsh: ${message}\n`));
    let ctx: Context | undefined;
    let disposal: Promise<void> | undefined;
    const dispose = () => disposal ??= (async () => {
        try { await ctx?.fiber.dispose(); }
        finally { await releaseProxy(); }
    })();
    let closing: Promise<void> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const shutdown = {
        // Same five-second disposal grace and signal escalation as dsh 0.2.1-alpha.4.
        shutdown(code: number, interrupt = false) {
            if (closing) { if (interrupt && !finished) process.exit(code); return closing; }
            exitTimer = setTimeout(() => process.exit(code), 5_000);
            closing = Promise.resolve().then(dispose).then(() => {
                finished = true;
                clearTimeout(exitTimer);
                if (interrupt) process.exit(code);
                process.exitCode = code;
            }, () => process.exit(code));
            return closing;
        },
    };
    const terminate = () => { void shutdown.shutdown(0, true); };
    const interrupt = () => { void shutdown.shutdown(130, true); };
    process.on("SIGTERM", terminate);
    process.on("SIGINT", interrupt);
    const releaseFailLoud = installFailLoud("dsh", process, dispose);
    const ready = new Set<() => void>();
    let readyCommitted = false;
    const startupPatches = readProfilePatches("dsh", profileContext, source);
    try {
        ctx = await boot("dsh", root, startupPatches, async (host) => {
            ctx = host;
            const sourceBase = pathToFileURL(source.dir + path.sep).href;
            host.baseUrl = sourceBase;
            host.loader.ctx.baseUrl = sourceBase;
            // Include owns a temporary file, while native presets and client module
            // metadata must capture the selected source's module-resolution base.
            host.on("loader/entry-init", () => {
                const include = host.loader.store.include?.subtree;
                if (include) include.ctx.baseUrl = sourceBase;
            });
            host.provide("profileContext", profileContext);
            host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, input.environment);
            await host.plugin(PluginPackages, { resolution });
            const prepared = prepareProfilePatches(host, startupPatches, sourceBase, "dsh");
            startupPatches.splice(0, startupPatches.length, ...prepared);
            provideCmdline(host, {
                args: ["--host", "127.0.0.1", "--port", "0", "--no-open"],
                exit: (code) => { void shutdown.shutdown(code); },
                ready: { onReady(listener) { if (readyCommitted) listener(); else ready.add(listener); return () => { ready.delete(listener); }; } },
            });
        }, pathToFileURL(path.join(source.dir, "package.json")).href);
        readyCommitted = !closing && ctx.fiber.state === 2 && ctx.get("loader") !== undefined;
        if (readyCommitted) for (const listener of ready) listener();
        ready.clear();
        ctx.effect(() => () => { process.off("SIGTERM", terminate); process.off("SIGINT", interrupt); releaseFailLoud(); });
        return { ctx, shutdown };
    } catch (error) {
        process.off("SIGTERM", terminate);
        process.off("SIGINT", interrupt);
        releaseFailLoud();
        await dispose();
        throw error;
    }
}
