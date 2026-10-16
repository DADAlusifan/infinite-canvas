import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionWireEvent } from "@deepseek-ai/dsh-api-session-controller/types";
import type { ClientRemote } from "@deepseek-ai/dsh-api-gateway/client";
import { AuthenticatedSocket, exchangeDshConnection } from "./transport.js";
import { installDraftIsolation } from "./draft-guard.js";
import { DshHistory } from "./history.js";
import { DshSession } from "./sessions.js";
import { canvasToolGuard } from "./admission.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { DshAgent } from "./index.js";

const event = (seq: number, type: string, data: unknown, surface = false) => ({ seq, time: seq + 1, type, data, ...(surface ? { surfaceOp: "append" } : {}) }) as SessionWireEvent;
const user = (id = "native-user") => ({ id, role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user-rpc", rpcId: "web-message" } });
const assistant = (id = "native-assistant") => ({ turn: 1, step: 1, message: { id, role: "assistant", content: [{ type: "text", text: "完成" }, { type: "reasoning", text: "思路" }], source: { kind: "model", provider: "fixture", model: "never-called" } }, stream: [] });

test("DSH /connect 保留 manual 302、独立 Cookie，拒绝跨源通道", async () => {
    let requested: URL | undefined;
    const doFetch = async (input: URL, init: RequestInit) => {
        requested = input;
        assert.equal(init.redirect, "manual");
        return new Response(null, { status: 302, headers: { Location: "./api/remote.mux", "Set-Cookie": "operator=fixture; HttpOnly; SameSite=Strict" } });
    };
    const result = await exchangeDshConnection({ url: "http://127.0.0.1:32768", token: "fixture-token" }, doFetch as typeof fetch);
    assert.equal(requested?.searchParams.get("interactions"), "answer");
    assert.equal(requested?.searchParams.get("token"), "fixture-token");
    assert.equal(result.cookie, "operator=fixture");
    assert.equal(result.mux.href, "http://127.0.0.1:32768/api/remote.mux");
    await assert.rejects(exchangeDshConnection({ url: "http://127.0.0.1:32768", token: "fixture-token" }, (async () => new Response(null, { status: 302, headers: { Location: "https://example.com/api/remote.mux", "Set-Cookie": "operator=x" } })) as typeof fetch), /无效/);
});

test("每次 Node socket 重连均重新交换独立 Peer，HTTP Cookie 不被当成可复用 socket 权限", async (context) => {
    let exchanges = 0;
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
        assert.equal(new URL(request.url!, "http://fixture").pathname, "/connect");
        response.writeHead(302, { Location: "./api/remote.mux", "Set-Cookie": `peer=${++exchanges}; HttpOnly` }); response.end();
    });
    const ws = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => { seen.push(request.headers.cookie || ""); ws.handleUpgrade(request, socket, head, (client) => ws.emit("connection", client, request)); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "fixture" };
    context.after(async () => { for (const client of ws.clients) client.terminate(); await new Promise<void>((resolve) => ws.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const connect = () => new Promise<AuthenticatedSocket>((resolve, reject) => {
        const socket = new AuthenticatedSocket(address, () => undefined, reject);
        socket.addEventListener("open", () => resolve(socket), { once: true });
    });
    const first = await connect(); first.close();
    const second = await connect(); second.close();
    assert.equal(exchanges, 2);
    assert.deepEqual(seen, ["peer=1", "peer=2"]);
});

test("DSH 原生消息以 runtime/session/turn/item 归属，历史物化后不重复并保留 native ID", () => {
    const history = new DshHistory("runtime-a", "session-a");
    const records = [event(0, "turn/start", { turn: 1 }), event(1, "user/message", user(), true), event(2, "assistant/message", assistant(), true), event(3, "turn/end", { turn: 1, reason: { kind: "completed" } })];
    for (const record of records) history.accept(record);
    assert.deepEqual(history.accept(records[2]), []);
    const messages = history.messages();
    assert.deepEqual(messages.map((message) => message.itemId), ["native-user", "native-assistant", "native-assistant:reasoning"]);
    assert.ok(messages.every((message) => message.threadId === "session-a" && message.runtimeId === "runtime-a" && message.turnId === "1"));
    assert.equal(messages[0].clientMessageId, "web-message");
    assert.deepEqual(history.settledTurnIds(), ["1"]);
    const other = new DshHistory("runtime-b", "session-b"); for (const record of records) other.accept(record);
    assert.equal(other.messages()[0].itemId, messages[0].itemId);
    assert.notEqual(other.messages()[0].threadId, messages[0].threadId);
});

test("原生 blocked 与 max-tokens 明确失败，completed 与 cancelled 保留成功/中断语义", () => {
    for (const kind of ["completed", "aborted", "blocked", "max-tokens", "error"]) {
        const history = new DshHistory("runtime", "session");
        const [terminal] = history.accept(event(0, "turn/end", { turn: 1, reason: { kind, ...(kind === "error" ? { error: { message: "native failure", code: "NATIVE" } } : {}) } }));
        assert.equal(terminal.type, ["completed", "aborted"].includes(kind) ? "turn.completed" : "turn.failed");
        assert.equal(terminal.status, kind === "aborted" ? "interrupted" : kind);
        if (["blocked", "max-tokens"].includes(kind)) assert.ok((terminal.error as { message: string }).message.includes(kind === "blocked" ? "阻断" : "输出上限"));
    }
});

test("画布 MCP admission 只接受前景 root 的真实运行时所有权树，拒绝原生 GUI 其他会话和旧实例", () => {
    const root = { id: SessionId("root") }, child = { id: SessionId("child") }, grandchild = { id: SessionId("grandchild") }, external = { id: SessionId("external") };
    const live = [root, child, grandchild, external];
    const parents = new Map([[child.id, root], [grandchild.id, child]]);
    let admitted: string | undefined;
    const guard = canvasToolGuard({ get: (id) => live.find((agent) => agent.id === id), list: () => live, isOwnedBy: (id, owner) => parents.get(id) === owner }, () => admitted);
    const execution = (agent: typeof root, name = "mcp__infinite-canvas__canvas_get_state") => ({ agent, name }) as unknown as ToolExecution;
    assert.ok(guard(execution(root)));
    admitted = root.id;
    for (const agent of [root, child, grandchild]) assert.equal(guard(execution(agent)), undefined);
    assert.ok(guard(execution(external)));
    assert.ok(guard(execution({ id: root.id })));
    assert.equal(guard(execution(external, "read_file")), undefined);
    admitted = undefined;
    assert.ok(guard(execution(child)));
});

test("工具 native call/result 合并一条，模型历史替换与注入消息不伪装成人类消息", () => {
    const history = new DshHistory("runtime", "session");
    history.accept(event(0, "turn/start", { turn: 1 }));
    history.accept(event(1, "tool/call", { turn: 1, step: 1, callId: "call", name: "canvas_get_state", arguments: "{}" }));
    history.accept(event(2, "tool/result", { turn: 1, step: 1, message: { id: "tool-message", role: "tool", toolCallId: "call", content: [{ type: "text", text: "已读取" }], source: { kind: "tool", callId: "call" } } }, true));
    history.accept(event(3, "user/message", { ...user("context"), source: { kind: "instructions" } }, true));
    history.accept({ ...event(4, "assistant/message", assistant("replacement")), surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 } });
    const messages = history.messages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].itemId, "call");
    assert.equal(messages[0].text, "已读取");
    assert.equal(messages[0].detail?.status, "completed");
});

test("DSH 原生图片历史保留安全逻辑附件引用，不把宿主路径或凭据当 URL", () => {
    const history = new DshHistory("runtime", "native session");
    history.accept(event(0, "turn/start", { turn: 1 }));
    history.accept(event(1, "user/message", { ...user(), content: [{ type: "image", attachment: { attachmentId: "native-image", mediaType: "image/png", bytes: 12, width: 2, height: 3, name: "示例.png" } }] }, true));
    const image = history.messages()[0].attachments![0];
    assert.deepEqual(image, { id: "native-image", type: "image/png", size: 12, width: 2, height: 3, name: "示例.png", url: "/agent/dsh/native-attachments/native%20session/native-image" });
});

test("DSH 关闭在中断和会话释放失败时仍释放连接并等待 owned child，重复关闭共用结果", async () => {
    const order: string[] = [];
    const agent = new DshAgent({ workspacePath: "fixture", runtimeId: "fixture", config: { url: "http://127.0.0.1", token: "fixture" }, emit() {} });
    Object.assign(agent, {
        active: { threadId: "thread", options: {} },
        sessions: new Map([["thread", { close: async () => { order.push("session"); throw new Error("session fixture failure"); } }]]),
        connection: { close: async () => { order.push("connection"); } },
        owned: { close: async () => { order.push("actual-exit"); } },
        interrupt: async () => { order.push("interrupt"); throw new Error("interrupt fixture failure"); },
    });
    const first = agent.close();
    assert.equal(agent.close(), first);
    await assert.rejects(first, AggregateError);
    assert.deepEqual(order, ["interrupt", "session", "connection", "actual-exit"]);
});

test("DSH 启动失败先证明旧 owned 退出再创建新 owner，runtimeId 稳定且不偷偷启动重试", async () => {
    const order: string[] = [];
    const agent = new DshAgent({ workspacePath: "fixture", runtimeId: "runtime", config: { url: "http://127.0.0.1", token: "fixture" }, emit() {} });
    const old = { isStopped: false, start: async () => { order.push("start"); throw new Error("startup fixture"); }, close: async () => { order.push("actual-exit"); } };
    Object.assign(agent, { owned: old });
    await assert.rejects(agent.start(), /startup fixture/);
    assert.deepEqual(order, ["start", "actual-exit"]);
    assert.notEqual((agent as unknown as { owned: unknown }).owned, old);
    assert.equal(agent.runtimeId, "runtime");
    await agent.close();
});

test("模型路由同名且缺 provider 时拒绝猜测，effort-only 使用当前会话模型", async () => {
    const agent = new DshAgent({ workspacePath: "fixture", config: { url: "http://127.0.0.1", token: "fixture" }, emit() {} });
    const select = (agent as unknown as { modelSelection: (catalog: unknown, options: unknown, fallback?: unknown) => unknown }).modelSelection.bind(agent);
    const catalog = { default: { provider: "first", model: "same" }, groups: [{ id: "first", models: [{ id: "same" }] }, { id: "second", models: [{ id: "same" }, { id: "current" }] }] };
    assert.throws(() => select(catalog, { model: "same" }), /不明确/);
    assert.deepEqual(select(catalog, { provider: "second", model: "same", effort: "native-special" }), { provider: "second", model: "same", reasoningEffort: "native-special" });
    assert.deepEqual(select(catalog, { effort: "light" }, { provider: "second", model: "current" }), { provider: "second", model: "current", reasoningEffort: "light" });
    await agent.close();
});

test("草稿在真实官方工具注册表中隐藏工具，并拒绝后来注册的 scoped 工具与 allow listener", async (context) => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime, { mode: "ptc" });
    context.after(() => ctx.fiber.dispose());
    const agent = { id: SessionId("draft") };
    let scope: ReturnType<typeof createScope>;
    await ctx.plugin({ inject: ["tools"], apply: (injected) => { scope = createScope(injected, agent); } });
    let calls = 0;
    const definition = { name: "fixture", description: "fixture", parameters: { type: "object" as const, properties: {} }, output: { schema: { type: "string" as const }, render: () => [{ type: "text" as const, text: "executed" }] }, execute: async () => { calls++; return "executed"; } };
    ctx.tools.register(definition);
    installDraftIsolation(scope.ctx, agent);
    assert.deepEqual(scope.ctx.tools.schemas(agent), []);
    scope.ctx.tools.register({ ...definition, name: "late-scoped" });
    scope.ctx.on("tools/pre-execute", async () => ({ kind: "allow" as const }));
    const result = await scope.ctx.tools.execute({ callId: ToolCallId("draft-call"), name: "late-scoped", arguments: {}, agent, signal: new AbortController().signal });
    assert.equal(calls, 0);
    assert.equal(result.isError, true);
});

test("原生 follow 分页补全历史、提交替换 stream item，基线不重复广播旧 turn", async () => {
    const updates: Record<string, unknown>[] = [];
    const abort = new AbortController();
    const stop = new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    let pageCalls = 0;
    const fake = {
        session: { page: async () => { pageCalls++; return { ok: true, value: { records: [{ type: "event", event: event(0, "turn/start", { turn: 1 }) }], hasMore: false } }; } },
        $stream: () => ({
            dispose: async () => abort.abort(),
            async *[Symbol.asyncIterator]() {
                const frames = [
                    { type: "snapshot", header: { id: "session", cwd: "fixture" }, cursor: 1, records: [{ type: "event", event: event(1, "user/message", user(), true) }], hasMore: true, projections: { values: {} } },
                    { type: "assistant-stream", frame: { type: "start", attemptId: "attempt", revision: 1, turn: 1, step: 1 } },
                    { type: "assistant-stream", frame: { type: "chunk", attemptId: "attempt", revision: 2, index: 0, time: 3, chunk: { type: "text-delta", index: 0, text: "完" } } },
                    { type: "event", event: event(2, "assistant/message", assistant(), true) },
                    { type: "event", event: event(3, "turn/end", { turn: 1, reason: { kind: "completed" } }) },
                ];
                for (const value of frames) yield { value, generation: 1, signal: abort.signal, accept() {} };
                await stop;
            },
        }),
    } as unknown as ClientRemote;
    const session = new DshSession(fake, "runtime", SessionId("session"), (value) => updates.push(value));
    await session.through(3);
    assert.equal(pageCalls, 1);
    assert.equal(updates.filter((value) => value.type === "turn.started").length, 0);
    assert.equal(updates.filter((value) => value.type === "turn.completed").length, 1);
    assert.ok(updates.some((value) => value.type === "message.updated"));
    assert.ok(updates.some((value) => value.type === "message.completed" && value.removeItemId === "attempt"));
    assert.ok(updates.some((value) => value.type === "message.completed" && value.removeItemId === "attempt:reasoning"));
    assert.equal(session.history.messages().filter((value) => value.role === "assistant").length, 1);
    assert.equal((session as unknown as { attempts: Map<string, unknown> }).attempts.size, 0);
    await session.close();
});
