import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Document } from "yaml";
import { DshAgent } from "./index.js";
import { OwnedDshRuntime } from "./owned-runtime.js";
import { createDshConnection, unwrapDsh } from "./transport.js";
import { SessionId } from "@deepseek-ai/dsh-session/types";

test("Web/Desktop 原生配置独立加载、保留模块解析和原始文件，后台 Host 不加载桌面模块，设置只编辑选源", { skip: process.env.CANVAS_DSH_NATIVE_SMOKE !== "1" }, async (context) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-dsh-profiles-"));
    const workspacePath = path.join(temporary, "workspace");
    const home = path.join(temporary, "dsh-home");
    await fs.mkdir(workspacePath);
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["Path", "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary });
    const snapshots = new Map<string, string>();
    const sourceNames = ["web", "desktop"] as const;
    for (const profile of sourceNames) {
        const dir = path.join(home, "profiles", profile);
        const packageName = profile === "desktop" ? "dsh-workbuddy-connect" : "web-provider-fixture";
        const plugin = path.join(dir, "node_modules", packageName);
        await fs.mkdir(plugin, { recursive: true });
        const files = {
            "package.json": JSON.stringify({ name: `fixture-${profile}`, dependencies: { [packageName]: "1.0.0" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", packageName] } } }),
            "cordis.yml": "# original source root must stay byte-for-byte intact\n[]\n",
            "cordis.patch.yml": new Document([
                { id: "agent-default-model", config: { provider: `${profile}-provider`, model: `${profile}-provider-model` } },
                { insert: [{ id: "desktop-runtime", name: "./desktop-surface.mjs" }, { id: "source-module", name: "./source-module.mjs" }] },
            ]).toString(),
            "credentials.json": "{\"fixture-only\":\"never-read-or-overwritten\"}\n",
            "desktop-surface.mjs": "import fs from 'node:fs'; fs.writeFileSync('desktop-launched', 'unexpected'); throw new Error('Desktop surface loaded');\n",
            "source-module.mjs": `import fs from 'node:fs'; export default { name: 'source-module', apply(ctx) { ctx.appReady.onReady(() => fs.writeFileSync('source-module-${profile}', JSON.stringify({ loaded: true, desktopSurfaceActive: [...ctx.loader.entries()].some(entry => ['include/desktop-runtime', 'include/ui-sidebar-browser'].includes(entry.id) && !!entry.fiber) }))); } };\n`,
        };
        for (const [file, contents] of Object.entries(files)) {
            const target = path.join(dir, file);
            await fs.writeFile(target, contents);
            snapshots.set(target, contents);
        }
        await fs.writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0", type: "module", exports: { ".": "./index.js", "./package.json": "./package.json" }, dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
        await fs.writeFile(path.join(plugin, "cordis.patch.yml"), new Document([{ insert: [{ id: `${profile}-provider`, name: packageName }] }]).toString());
        await fs.copyFile(fileURLToPath(new URL("./fixtures/profile-plugin.mjs", import.meta.url)), path.join(plugin, "index.js"));
        await fs.writeFile(path.join(plugin, "route.js"), `export const provider = ${JSON.stringify(`${profile}-provider`)};\n`);
    }
    let owned: OwnedDshRuntime | undefined;
    let connection: Awaited<ReturnType<typeof createDshConnection>> | undefined;
    context.after(async () => { await connection?.close(); await owned?.close(); await fs.rm(temporary, { recursive: true, force: true }); });
    for (const profile of sourceNames) {
        const events: string[] = [];
        owned = new OwnedDshRuntime({ workspacePath, runtimeId: `profile-${profile}`, config: { url: "http://127.0.0.1", token: "fixture", dsh: { home, profile } }, environment, emit(type, payload) { if (type === "agent_log") process.stderr.write(String((payload as { text?: string }).text ?? "")); if (type === "dsh_event") events.push((payload as { type: string }).type); } });
        const address = await owned.start();
        assert.equal(new URL(address.url).hostname, "127.0.0.1");
        assert.notEqual(new URL(address.url).port, "0");
        connection = await createDshConnection(address);
        const catalog = unwrapDsh(await connection.ctx.remote.session.modelCatalog());
        assert.equal(catalog.default.provider, `${profile}-provider`);
        assert.ok(catalog.groups.some((group) => group.id === `${profile}-provider`), JSON.stringify({ groups: catalog.groups, failures: catalog.failures }));
        assert.ok(!catalog.groups.some((group) => group.id === `${profile === "web" ? "desktop" : "web"}-provider`));
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspacePath, `source-module-${profile}`), "utf8")), { loaded: true, desktopSurfaceActive: false });
        for (const [target, contents] of snapshots) assert.equal(await fs.readFile(target, "utf8"), contents);
        const loaded = (await fs.readFile(path.join(workspacePath, "profile-runtime.jsonl"), "utf8")).trim().split("\n").map((row) => JSON.parse(row));
        assert.ok(loaded.some((row) => row.provider === `${profile}-provider` && row.profile === profile && row.dir === path.join(home, "profiles", profile) && row.patchPath === path.join(home, "profiles", profile, "cordis.patch.yml")));
        const edited = unwrapDsh(await connection.ctx.remote.settings.update("agent-default-model", { model: `${profile}-edited` }, undefined));
        assert.ok(edited);
        const sourcePatch = path.join(home, "profiles", profile, "cordis.patch.yml");
        const updated = await fs.readFile(sourcePatch, "utf8");
        assert.ok(updated.includes(`${profile}-edited`));
        snapshots.set(sourcePatch, updated);
        for (const [target, contents] of snapshots) assert.equal(await fs.readFile(target, "utf8"), contents);
        await assert.rejects(fs.access(path.join(workspacePath, "desktop-launched")), { code: "ENOENT" });
        await connection.close(); connection = undefined;
        await owned.close(); owned = undefined;
        assert.ok(events.includes("runtime.exited"));
    }
    const incompatible = path.join(home, "profiles", "desktop", "node_modules", "dsh-workbuddy-connect", "package.json");
    const manifest = JSON.parse(await fs.readFile(incompatible, "utf8"));
    manifest.peerDependencies = { "@deepseek-ai/dsh-llm": "0.2.0-rc.2" };
    await fs.writeFile(incompatible, JSON.stringify(manifest));
    owned = new OwnedDshRuntime({ workspacePath, runtimeId: "incompatible-profile", config: { url: "http://127.0.0.1", token: "fixture", dsh: { home, profile: "desktop" } }, environment, emit() {} });
    await assert.rejects(owned.start(), (error: Error) => /dsh-workbuddy-connect/.test(error.message) && /0\.2\.0-rc\.2/.test(error.message) && /0\.2\.1-alpha\.4/.test(error.message));
    await owned.close(); owned = undefined;
    for (const [target, contents] of snapshots) assert.equal(await fs.readFile(target, "utf8"), contents);
});

// Opt-in: official Host, empty isolated home, and a local in-process model fixture only.
test("隔离 DSH_HOME：真实 Host/Gateway/MCP、原生图片历史/工具/取消/草稿/退出，仅本地模拟模型", { skip: process.env.CANVAS_DSH_NATIVE_SMOKE !== "1" }, async (context) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-dsh-native-smoke-"));
    const workspacePath = path.join(temporary, "workspace");
    const home = path.join(temporary, "dsh-home");
    await fs.mkdir(workspacePath); await fs.mkdir(home);
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["Path", "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary });
    const calls: Array<{ engineId?: string; runtimeId?: string; name?: string }> = [];
    const mock = http.createServer(async (request, response) => {
        let body = ""; for await (const chunk of request) body += chunk;
        calls.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true, result: { title: "fixture", nodes: [], connections: [] } }));
    });
    mock.listen(0, "127.0.0.1"); await once(mock, "listening");
    const config = { url: `http://127.0.0.1:${(mock.address() as { port: number }).port}`, token: "fixture-canvas-token", dsh: { home } };
    const events: Array<{ type: string; payload: unknown }> = [];
    const emit = (type: string, payload: unknown) => {
        events.push({ type, payload });
        if (type === "agent_log") process.stderr.write(String((payload as { text?: string }).text || ""));
        if (type === "dsh_approval") agent?.resolveApproval((payload as { requestId: string }).requestId, "allowed-once");
    };
    const owned = new OwnedDshRuntime({ workspacePath, runtimeId: "smoke-runtime", config, environment, emit });
    let connection: Awaited<ReturnType<typeof createDshConnection>> | undefined;
    let agent: DshAgent | undefined;
    context.after(async () => {
        await connection?.close();
        await agent?.close();
        await owned.close();
        await new Promise<void>((resolve) => mock.close(() => resolve()));
        await fs.rm(temporary, { recursive: true, force: true });
    });
    const address = await owned.start();
    assert.equal(new URL(address.url).hostname, "127.0.0.1");
    assert.ok(address.token);
    connection = await createDshConnection(address);
    const catalog = unwrapDsh(await connection.ctx.remote.session.modelCatalog());
    assert.ok(Array.isArray(catalog.groups));
    const created = unwrapDsh(await connection.ctx.remote.session.create({ cwd: workspacePath }));
    const follow = connection.ctx.remote.session.follow({ address: { kind: "session", sessionId: created.sessionId }, assistantStream: true });
    try {
        const opening = await follow[Symbol.asyncIterator]().next();
        assert.equal(opening.value?.type, "snapshot");
    } finally { follow.dispose(); }
    unwrapDsh(await connection.ctx.remote.session.cancel({ sessionId: created.sessionId }));
    await owned.request("session.quiesce", { sessionId: created.sessionId, cancel: true });
    const draft = await owned.request("draft.create") as { sessionId: string };
    assert.ok(draft.sessionId);
    unwrapDsh(await connection.ctx.remote.skills.list({ sessionId: SessionId(draft.sessionId) }));
    await owned.request("draft.dispose", { sessionId: draft.sessionId });
    await connection.close(); connection = undefined;
    await owned.close();
    assert.ok(events.some((event) => event.type === "dsh_event" && (event.payload as { type?: string }).type === "runtime.exited"));
    // Empty credentials must not prevent handing off the owned official configuration UI.
    let opened = false;
    agent = new DshAgent({ workspacePath, runtimeId: "settings-smoke", config, environment, emit, openExternal: async (url) => { const native = new URL(url); assert.equal(native.hostname, "127.0.0.1"); assert.ok(native.searchParams.get("token")); opened = true; } });
    await agent.openSettings();
    assert.equal(opened, true);
    await agent.close(); agent = undefined;
    assert.ok(events.every((event) => !JSON.stringify(event.payload).includes(address.token)));

    const patchFile = path.join(home, "cordis.patch.yml");
    await fs.writeFile(patchFile, new Document([
        { id: "agent-default-model", config: { provider: "fixture", model: "fixture" } },
        { id: "tools", config: { mode: "native" } },
        { insert: [{ id: "local-model-fixture", name: fileURLToPath(new URL("./fixtures/model-plugin.mjs", import.meta.url)) }] },
    ]).toString());
    agent = new DshAgent({ workspacePath, runtimeId: "model-smoke", config, environment, emit });
    await agent.start();
    const thread = (await agent.newThread()).thread;
    const png = (await import("sharp")).default;
    const image = await png({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    await agent.runTurn("fixture text", [{ name: "fixture.png", dataUrl: `data:image/png;base64,${image.toString("base64")}` }], { threadId: thread.id, clientMessageId: "fixture-user" });
    const history = await agent.readThread(thread.id);
    assert.equal(history.messages.filter((message) => message.role === "assistant").length, 1);
    assert.ok(history.messages.some((message) => message.text === "fixture text completed"));
    const userMessage = history.messages.find((message) => message.clientMessageId === "fixture-user")!;
    assert.equal(userMessage.attachments?.length, 1);
    const attachment = await agent.readAttachment(thread.id, userMessage.attachments![0].id);
    assert.equal(attachment.attachment.mediaType, "image/png");
    assert.ok(Buffer.from(attachment.data, "base64").length > 0);
    await assert.rejects(agent.readAttachment(thread.id, "not-in-session"), /不属于/);
    await agent.runTurn("fixture tools", [], { threadId: thread.id, clientMessageId: "fixture-tool-user" });
    const withTool = await agent.readThread(thread.id);
    assert.ok(withTool.messages.some((message) => message.role === "tool" && message.title === "mcp__infinite-canvas__canvas_get_state"));
    assert.ok(withTool.messages.some((message) => message.text === "fixture tools completed"));
    assert.ok(calls.some((call) => call.name === "canvas_get_state" && call.engineId === "dsh" && call.runtimeId === "model-smoke"));
    const records = async () => (await fs.readFile(path.join(workspacePath, "fixture-model-calls.jsonl"), "utf8")).trim().split("\n").map((row) => JSON.parse(row) as { kind: string; toolNames: string[]; imageCount: number; canceled?: boolean });
    const cancelTask = agent.runTurn("fixture cancel", [], { threadId: thread.id });
    await Promise.race([
        (async () => { while (!(await records()).some((row) => row.kind === "cancel")) await delay(10); })(),
        cancelTask.then(() => { throw new Error("fixture cancel prematurely ended"); }),
    ]);
    assert.equal(await agent.interrupt(thread.id), true);
    await cancelTask;
    assert.ok((await records()).some((row) => row.kind === "cancel" && row.canceled));
    const beforeDraft = await fs.readFile(patchFile, "utf8");
    const draftText = await agent.generateSkillDraft({ source: "conversation", threadId: thread.id, prompt: "生成 Skill 草稿，只返回 outputSchema 对象", outputSchema: { type: "object" }, model: "fixture", provider: "fixture" });
    assert.equal(JSON.parse(draftText).name, "fixture-workflow");
    assert.equal(await fs.readFile(patchFile, "utf8"), beforeDraft);
    assert.ok((await records()).some((row) => row.kind === "draft" && row.toolNames.length === 0));
    assert.ok((await records()).some((row) => row.imageCount > 0));
    assert.ok((await records()).every((row) => row.toolNames.every((name) => !name.includes("dsh_session_log"))));
    await assert.rejects(fs.access(path.join(workspacePath, "fixture-outbound.jsonl")), { code: "ENOENT" });
    await agent.archiveThread(thread.id);
    assert.ok(!(await agent.threads()).data.some((item) => item.id === thread.id));
    await agent.close(); agent = undefined;
});
