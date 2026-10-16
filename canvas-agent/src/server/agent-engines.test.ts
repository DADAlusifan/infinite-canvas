import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import test from "node:test";
import type { TestContext } from "node:test";
import express from "express";
import type { DshAgent } from "../agent/dsh/index.js";
import { CODEX_ENGINE, type DshConfigProfile } from "../agent/engine.js";
import { MessageMetadataStore } from "../agent/message-metadata.js";
import { CanvasSession } from "../canvas/session.js";
import type { CanvasAgentConfig } from "../config.js";
import { agentRequestScope } from "./agent-scope.js";
import { DshController } from "./dsh.js";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

class Events extends EventEmitter {
    chunks: string[] = [];
    writeHead() { return this; }
    write(value: string) { this.chunks.push(value); return true; }
    values(type: string) {
        return this.chunks.filter((chunk) => chunk.startsWith(`event: ${type}\n`)).map((chunk) => JSON.parse(chunk.split("\ndata: ")[1]));
    }
}

test("HTTP engine fences reject stale writes and retain the original scope on delayed reads", async (t) => {
    const session = new CanvasSession();
    const app = express();
    const entered = deferred(), finish = deferred();
    let writes = 0;
    app.use(express.json(), agentRequestScope(session));
    app.post("/agent/codex/turn", (_req, res) => { writes++; res.json({ ok: true }); });
    app.get("/agent/codex/threads", async (_req, res) => { entered.resolve(); await finish.promise; res.json({ ok: true, data: [] }); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const scope = session.scope;
    const stale = await fetch(`${origin}/agent/codex/turn?engineId=codex&runtimeId=old`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(stale.status, 409);
    assert.equal(writes, 0);
    const missing = await fetch(`${origin}/agent/codex/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 409);
    const response = fetch(`${origin}/agent/codex/threads?${new URLSearchParams(scope)}`);
    await entered.promise;
    session.selectEngine("dsh");
    finish.resolve();
    const body = await (await response).json();
    assert.equal(body.engineId, "codex");
    assert.equal(body.runtimeId, scope.runtimeId);
    assert.equal((await fetch(`${origin}/agent/codex/turn?${new URLSearchParams(scope)}`, { method: "POST" })).status, 409);
    assert.equal(writes, 0);
});

test("DSH controller routes a simulated turn to its source canvas and keeps the lock until native stop settles", async (t) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-dsh-controller-"));
    t.after(async () => { assert.equal(path.dirname(temporary), os.tmpdir()); await rm(temporary, { recursive: true, force: true }); });
    const session = new CanvasSession();
    session.selectEngine("dsh");
    const first = new Events(), second = new Events();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=first"), first as unknown as ServerResponse);
    session.openEvents(new URL("http://127.0.0.1/events?clientId=second"), second as unknown as ServerResponse);
    t.after(() => { first.emit("close"); second.emit("close"); });
    session.updateState({ projectId: "first", nodes: [], connections: [] }, "first");
    session.updateState({ projectId: "second", nodes: [], connections: [] }, "second");
    const running = deferred(), stopped = deferred();
    let runtimeEmit!: (type: string, payload: unknown) => void;
    const calls: Array<Record<string, unknown>> = [];
    const native = {
        capabilities: { permissions: [{ id: "workspace-write", title: "工作区写入" }] },
        start: async () => {},
        newThread: async () => ({ id: "native-session", preview: "DSH", cwd: temporary }),
        runTurn: async (_prompt: string, _attachments: unknown[], options: Record<string, unknown>) => {
            calls.push(options);
            (options.onTurn as (id: string) => void)("native-turn");
            running.resolve(); await stopped.promise;
        },
        interrupt: async () => { stopped.resolve(); return true; },
        close: async () => {},
    } as unknown as DshAgent;
    const controller = new DshController({
        config: { url: "http://127.0.0.1:17371", token: "test", workspace: { workspacePath: temporary } },
        session, persist: () => {}, createRuntime: async (emit) => { runtimeEmit = emit; return native; },
        metadata: new MessageMetadataStore(path.join(temporary, "metadata")),
    });
    await controller.prepare("first");
    assert.equal(session.conversationStateSnapshot.status, "ready");
    assert.equal(controller.descriptor().capabilities.permissions[0].id, "workspace-write");
    const app = express();
    app.use(express.json(), agentRequestScope(session));
    controller.register(app);
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (route: string, body: unknown) => fetch(`${origin}/agent/dsh/${route}?${new URLSearchParams(session.scope)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const body = { prompt: "create text", messageId: "client-message", clientId: "first", threadId: "native-session", conversationId: session.conversationStateSnapshot.conversationId, expectedRevision: session.conversationStateSnapshot.revision };
    const stale = await post("turn", { ...body, expectedRevision: 0 });
    assert.equal(stale.status, 409);
    assert.equal(calls.length, 0);
    session.updateState({ hasCanvas: false }, "second");
    assert.equal((await post("skills/draft", { source: "canvas", clientId: "second" })).status, 409);
    assert.equal((await post("turn", body)).status, 200);
    await running.promise;
    assert.equal(calls[0].clientMessageId, "client-message");
    assert.equal(session.agentBusy, true);
    assert.equal(session.beginMutation(), false);
    runtimeEmit("dsh_event", { threadId: "old-session", turnId: "old-turn", type: "turn.started" });
    runtimeEmit("dsh_approval", { threadId: "old-session", turnId: "old-turn", requestId: "old-approval" });
    assert.equal(session.runStateSnapshot.turnId, "native-turn");
    assert.equal(session.pendingApprovalSnapshot.length, 0);
    session.trackEvent("dsh_approval", { threadId: "native-session", turnId: "native-turn", requestId: "real-approval" });
    runtimeEmit("agent_error", { threadId: "old-session", turnId: "old-turn", message: "late failure" });
    assert.equal(session.pendingApprovalSnapshot.length, 1);
    session.trackEvent("dsh_approval_resolved", { requestId: "real-approval" });
    session.activateClient("second");
    const tool = session.callTool("canvas_create_text_node", { text: "source only" }, { scope: session.scope });
    assert.equal(second.values("tool_call").length, 0);
    const toolCall = first.values("tool_call").at(-1);
    assert.equal(session.resolveResult("first", { requestId: toolCall.requestId, result: { ok: true } }), true);
    await tool;
    assert.equal((await post("interrupt", { threadId: "native-session" })).status, 200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(session.agentBusy, false);
    assert.equal(session.beginMutation(), true);
    session.endMutation();
});

async function profileFixture(t: TestContext, hooks: {
    close?: (index: number) => Promise<void>;
    start?: (index: number) => Promise<void>;
    read?: (index: number) => Promise<void>;
    persist?: (config: CanvasAgentConfig) => void;
} = {}) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-dsh-profile-"));
    t.after(async () => { assert.equal(path.dirname(temporary), os.tmpdir()); await rm(temporary, { recursive: true, force: true }); });
    const config: CanvasAgentConfig = {
        url: "http://127.0.0.1:17371", token: "test", workspace: { workspacePath: temporary },
        dsh: { profile: "web", home: path.join(temporary, "native"), activeThreadId: "web-thread" },
    };
    const session = new CanvasSession();
    session.selectEngine("dsh");
    const clients = [new Events(), new Events()];
    clients.forEach((client, index) => session.openEvents(new URL(`http://127.0.0.1/events?clientId=${index ? "second" : "first"}`), client as unknown as ServerResponse));
    t.after(() => clients.forEach((client) => client.emit("close")));
    const calls: string[] = [], persisted: CanvasAgentConfig[] = [];
    const runtimes: Array<{ profile: DshConfigProfile; activeThreadId?: string; emit: (type: string, payload: unknown) => void }> = [];
    const history = new Map([["web-thread", { thread: { id: "web-thread" }, messages: [{ role: "assistant", threadId: "web-thread", turnId: "old-turn", text: "native history" }] }]]);
    const controller = new DshController({
        config, session, metadata: new MessageMetadataStore(path.join(temporary, "metadata")),
        persist: (value) => { hooks.persist?.(value); persisted.push(structuredClone(value)); calls.push(`persist:${value.dsh?.profile}:${value.dsh?.activeThreadId || ""}`); },
        descriptorsChanged: () => session.setEngineDescriptors([CODEX_ENGINE, controller.descriptor()]),
        createRuntime: async (emit) => {
            const index = runtimes.length, profile = config.dsh!.profile!;
            runtimes.push({ profile, activeThreadId: config.dsh?.activeThreadId, emit });
            calls.push(`create:${profile}`);
            return {
                capabilities: { permissions: [{ id: `${profile}-permission`, title: profile }] },
                start: async () => { calls.push(`start:${profile}`); await hooks.start?.(index); },
                close: async () => { calls.push(`close:${profile}`); await hooks.close?.(index); calls.push(`closed:${profile}`); },
                newThread: async () => { calls.push(`new:${profile}`); return { id: `${profile}-thread-${index}` }; },
                resumeThread: async (id: string) => { calls.push(`resume:${profile}:${id}`); return history.get(id); },
                readThread: async (id: string) => { await hooks.read?.(index); return history.get(id); },
                models: async () => ({ data: [{ id: `${profile}-model` }] }),
                archiveThread: async (id: string) => { calls.push(`archive:${id}`); history.delete(id); },
            } as unknown as DshAgent;
        },
    });
    session.setEngineDescriptors([CODEX_ENGINE, controller.descriptor()]);
    await controller.prepare("first");
    const app = express();
    app.use(express.json(), agentRequestScope(session));
    controller.register(app);
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const change = (body: Record<string, unknown> = {}) => fetch(`${origin}/agent/engines/dsh/profile`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "desktop", clientId: "first", expectedEngineId: "dsh", runtimeId: session.scope.runtimeId, ...body }),
    });
    const get = (route: string, scope = session.scope) => fetch(`${origin}/agent/dsh/${route}?${new URLSearchParams(scope)}`);
    return { config, session, clients, calls, persisted, runtimes, history, controller, change, get };
}

test("DSH profile changes reject invalid, stale, disconnected and busy requests without touching the runtime", async (t) => {
    const f = await profileFixture(t), initialScope = f.session.scope;
    const initialConfig = structuredClone(f.config), initialCalls = [...f.calls];
    for (const [body, status] of [
        [{ profile: "invalid" }, 400], [{ profile: null }, 400], [{ clientId: "detached" }, 409],
        [{ expectedEngineId: "codex" }, 409], [{ runtimeId: "" }, 409], [{ runtimeId: "old" }, 409],
    ] as const) assert.equal((await f.change(body)).status, status);
    f.session.selectEngine("codex");
    assert.equal((await f.change({ runtimeId: initialScope.runtimeId })).status, 409);
    f.session.selectEngine("dsh");
    const busy = async () => {
        const response = await f.change();
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, "CONVERSATION_BUSY");
    };
    f.session.setRunState({ busy: true });
    await busy();
    f.session.setRunState({ busy: false });
    f.session.trackEvent("dsh_approval", { requestId: "approval" });
    await busy();
    f.session.trackEvent("dsh_approval_resolved", { requestId: "approval" });
    assert.equal(f.session.beginMutation(), true);
    await busy();
    f.session.endMutation();
    f.session.beginConversation({ threadId: "web-thread" });
    await busy();
    f.session.activateConversation("web-thread");
    f.clients[1].emit("close");
    assert.equal((await f.change({ clientId: "second" })).status, 409);
    assert.deepEqual(f.config, initialConfig);
    assert.deepEqual(f.calls, initialCalls);
    assert.deepEqual(f.session.scope, initialScope);
    assert.equal(f.session.globalBusy, false);
});

test("DSH profile changes await shutdown, fence the old runtime and synchronize the new source across pages", async (t) => {
    const closing = deferred(), closed = deferred(), reading = deferred(), read = deferred();
    t.after(() => { closed.resolve(); read.resolve(); });
    const f = await profileFixture(t, {
        close: async (index) => { if (!index) { closing.resolve(); await closed.promise; } },
        read: async (index) => { if (!index) { reading.resolve(); await read.promise; } },
    });
    const oldScope = f.session.scope;
    f.session.setTurnAttachments("first", [{ id: "old-attachment", dataUrl: "data:image/png;base64,eA==" }]);
    const oldRead = f.get("threads/web-thread", oldScope);
    await reading.promise;
    const switching = f.change();
    await closing.promise;
    assert.equal(f.config.dsh?.profile, "web");
    assert.equal(f.runtimes.length, 1);
    assert.deepEqual(f.session.scope, oldScope);
    assert.equal((await f.change({ clientId: "second" })).status, 409);
    closed.resolve();
    const response = await switching, body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.engineId, "dsh");
    assert.equal(body.runtimeId, f.session.scope.runtimeId);
    assert.notEqual(body.runtimeId, oldScope.runtimeId);
    assert.equal(body.globalBusy, false);
    assert.equal(body.engine.configProfile, "desktop");
    assert.equal(body.conversation.status, "ready");
    assert.equal(body.conversation.sourceClientId, "first");
    assert.equal(body.workspace.activeThreadId, "desktop-thread-1");
    assert.deepEqual(f.runtimes.map(({ profile, activeThreadId }) => ({ profile, activeThreadId })), [
        { profile: "web", activeThreadId: "web-thread" }, { profile: "desktop", activeThreadId: undefined },
    ]);
    const lifecycle = f.calls.slice(f.calls.indexOf("close:web"));
    assert.deepEqual(lifecycle, ["close:web", "closed:web", "persist:desktop:", "create:desktop", "start:desktop", "new:desktop", "persist:desktop:desktop-thread-1"]);
    assert.equal(f.config.dsh?.home, path.join(f.config.workspace!.workspacePath, "native"));
    const event = f.clients[0].values("engine_changed").at(-1);
    assert.deepEqual(event, f.clients[1].values("engine_changed").at(-1));
    assert.equal(event.runtimeId, body.runtimeId);
    assert.equal(event.engine.configProfile, "desktop");
    assert.equal(event.engines.find((engine: { id: string }) => engine.id === "dsh").configProfile, "desktop");
    assert.equal(event.conversation.status, "ready");
    assert.equal(event.globalBusy, false);
    assert.deepEqual((await (await f.get("models")).json()).data, [{ id: "desktop-model" }]);
    assert.equal((await f.get("models", oldScope)).status, 409);
    assert.throws(() => f.session.getTurnAttachment("first", "old-attachment"), /找不到/);
    const eventCount = f.clients[0].chunks.length;
    f.runtimes[0].emit("dsh_approval", { threadId: body.workspace.activeThreadId, requestId: "late" });
    f.runtimes[0].emit("agent_error", { message: "old runtime failed" });
    assert.equal(f.session.pendingApprovalSnapshot.length, 0);
    assert.equal(f.clients[0].chunks.length, eventCount);
    read.resolve();
    const delayed = await (await oldRead).json();
    assert.equal(delayed.runtimeId, oldScope.runtimeId);
    assert.equal(delayed.messages[0].text, "native history");
    const count = f.calls.length, saved = f.persisted.length;
    assert.equal((await f.change({ clientId: "second" })).status, 200);
    assert.equal(f.session.scope.runtimeId, body.runtimeId);
    assert.equal(f.calls.length, count);
    assert.equal(f.persisted.length, saved);
    assert.equal((await f.change({ profile: "web" })).status, 200);
    assert.equal(f.runtimes.at(-1)?.profile, "web");
    assert.notEqual(f.session.scope.runtimeId, body.runtimeId);
    assert.equal(f.history.get("web-thread")?.messages[0].text, "native history");
    assert.equal(f.calls.some((call) => call.startsWith("archive:")), false);
});

test("DSH profile failures release the lock and preserve native history without silently changing the selected source", async (t) => {
    for (const phase of ["persist", "start"] as const) await t.test(phase, async (t) => {
        const f = await profileFixture(t, {
            persist: (config) => { if (phase === "persist" && config.dsh?.profile === "desktop") throw new Error("profile save failed"); },
            start: async (index) => { if (phase === "start" && index) throw new Error("desktop startup failed"); },
        });
        const previous = structuredClone(f.config.dsh), oldScope = f.session.scope;
        const response = await f.change();
        assert.equal(response.status, 500);
        assert.match((await response.json()).error, phase === "persist" ? /profile save failed/ : /desktop startup failed/);
        assert.equal(f.session.conversationStateSnapshot.status, "failed");
        assert.equal(f.session.globalBusy, false);
        assert.equal(f.session.beginMutation(), true);
        f.session.endMutation();
        assert.equal(f.history.get("web-thread")?.messages[0].text, "native history");
        assert.equal(f.calls.some((call) => call.startsWith("archive:")), false);
        if (phase === "persist") {
            assert.deepEqual(f.config.dsh, previous);
            assert.deepEqual(f.session.scope, oldScope);
            assert.equal(f.controller.descriptor().configProfile, "web");
            assert.equal(f.runtimes.length, 1);
        } else {
            assert.equal(f.config.dsh?.profile, "desktop");
            assert.equal(f.config.dsh?.activeThreadId, undefined);
            assert.notEqual(f.session.scope.runtimeId, oldScope.runtimeId);
            assert.deepEqual(f.runtimes.map((runtime) => runtime.profile), ["web", "desktop"]);
            assert.equal(f.calls.includes("new:desktop"), false);
            const event = f.clients[0].values("engine_changed").at(-1);
            assert.equal(event.engine.configProfile, "desktop");
            assert.equal(event.conversation.status, "failed");
            assert.equal(event.globalBusy, false);
            assert.deepEqual(event, f.clients[1].values("engine_changed").at(-1));
        }
    });
});
