import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { acceptsAgentEvent, agentIsBusy, agentSkillMarker, cancelPendingAgentTool, getAgentScope, isCurrentAgentScope, setAgentScope, StaleAgentResponseError, type AgentEngine } from "../src/lib/agent/agent-engine";
import { useAgentStore } from "../src/stores/use-agent-store";
import { useAgentSkillStore } from "../src/stores/use-agent-skill-store";
import { activateAgentEngine, agentTurnSettings, AgentApiError, fetchAgentJson, postAgentApproval, postToolResult, resolveAgentMessageAssetUrl, switchDshConfigProfile, type AgentSkillSummary } from "../src/services/api/canvas-agent";
import { agentMessageToChatMessage, bindPendingTurnMessages, mergeAgentMessages, normalizeHistoryMessages, registerLiveAgentTurn, scopeChatItem } from "../src/components/agent/agent-event-formatters";
import { mergeDshEventMessage, normalizeDshChatItem, type DshEvent } from "../src/components/agent/agent-dsh-events";
import { parseAgentInlineTokens } from "../src/components/agent/agent-chat-inline-tokens";

const initialAgent = useAgentStore.getState();
const initialSkills = useAgentSkillStore.getState();
const engines: AgentEngine[] = [
    { id: "codex", name: "Codex", capabilities: { permissions: [{ id: "request", title: "请求审批", description: "Codex 权限" }], skills: true, attachments: true, manageSettings: false } },
    { id: "dsh", name: "DSH", configProfile: "web", capabilities: { permissions: [{ id: "native-ask", title: "原生询问", description: "DSH 权限" }], skills: true, attachments: true, manageSettings: true } },
];
afterEach(() => {
    mock.restore();
    useAgentStore.setState(initialAgent, true);
    useAgentSkillStore.setState(initialSkills, true);
    setAgentScope("codex", "");
});
function connect(engine: "codex" | "dsh", runtimeId = `${engine}-runtime`) {
    useAgentStore.getState().applyEngine(engine, runtimeId, engines);
    useAgentStore.getState().setAgentState({ connected: true, url: "http://agent.test", token: "test", conversation: { revision: 1, conversationId: "conversation", threadId: "same-thread", status: "ready", mcpStatuses: {} } });
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}
const skill = (name: string): AgentSkillSummary => ({ name, path: `/${name}/SKILL.md`, description: name, scope: "user", enabled: true, managed: true });

test("engine round trips preserve drafts, images, native permission, model effort and colliding history IDs independently", () => {
    connect("codex");
    const attachment = { id: "image", name: "reference.png", type: "image/png", size: 2, width: 1, height: 1, url: "blob:reference", dataUrl: "data:image/png;base64,AA==" };
    useAgentStore.getState().setAgentState({ prompt: "Codex draft", attachments: [attachment], model: "codex-model", reasoningEffort: "xhigh", permissionMode: "request", activeThreadId: "same-thread", messages: [scopeChatItem({ id: "same", role: "assistant", text: "Codex history" }, "same-thread", "same-turn")] });
    connect("dsh");
    expect(useAgentStore.getState().prompt).toBe("");
    expect(useAgentStore.getState().attachments).toEqual([]);
    useAgentStore.getState().setAgentState({ prompt: "DSH draft", model: "provider/model", reasoningEffort: "native-adaptive", permissionMode: "native-ask", activeThreadId: "same-thread", messages: [scopeChatItem({ id: "same", role: "assistant", text: "DSH history" }, "same-thread", "same-turn")] });
    connect("codex");
    expect(useAgentStore.getState()).toMatchObject({ prompt: "Codex draft", attachments: [attachment], model: "codex-model", reasoningEffort: "xhigh", permissionMode: "request" });
    expect(useAgentStore.getState().messages[0].text).toBe("Codex history");
    connect("dsh");
    expect(useAgentStore.getState()).toMatchObject({ prompt: "DSH draft", model: "provider/model", reasoningEffort: "native-adaptive", permissionMode: "native-ask" });
    expect(useAgentStore.getState().messages[0].text).toBe("DSH history");
});

test("skill selection and unfinished skill drafts stay with their engine and use native invocation markers", () => {
    connect("codex");
    useAgentSkillStore.getState().selectSkill(skill("canvas-design"));
    const codexDraft = { name: "codex-draft", displayName: "Codex", description: "draft", instructions: "steps", shortDescription: "short", defaultPrompt: "$codex-draft" };
    useAgentSkillStore.getState().setDraft(codexDraft);
    expect(useAgentStore.getState().prompt).toBe("$canvas-design");
    connect("dsh");
    expect(useAgentSkillStore.getState().selectedSkill).toBeNull();
    useAgentSkillStore.getState().selectSkill(skill("native-work"));
    expect(useAgentStore.getState().prompt).toBe("/native-work");
    expect(agentSkillMarker("dsh", "native-work")).toBe("/native-work");
    const tokens = parseAgentInlineTokens("Use /native-work", [], { name: "native-work", path: "/native-work", engineId: "dsh" });
    expect(tokens.at(-1)?.type).toBe("skill");
    connect("codex");
    expect(useAgentSkillStore.getState().selectedSkill?.name).toBe("canvas-design");
    expect(useAgentSkillStore.getState().draft).toEqual(codexDraft);
    expect(useAgentStore.getState().prompt).toBe("$canvas-design");
});

test("late history responses are rejected even after switching away and back to the same engine instance", async () => {
    connect("codex");
    const pending = deferred<Response>();
    const request = spyOn(globalThis, "fetch").mockImplementation(() => pending.promise);
    const result = fetchAgentJson("http://agent.test", "test", "/agent/codex/threads/same-thread");
    expect(new URL(String(request.mock.calls[0][0])).searchParams.get("runtimeId")).toBe("codex-runtime");
    connect("dsh");
    connect("codex");
    pending.resolve(Response.json({ engineId: "codex", runtimeId: "codex-runtime", messages: [{ text: "old" }] }));
    await expect(result).rejects.toBeInstanceOf(StaleAgentResponseError);
    expect(useAgentStore.getState().messages).toEqual([]);
});

test("late skill lists never replace the new engine selection or prompt", async () => {
    connect("codex");
    const pending = deferred<Response>();
    spyOn(globalThis, "fetch").mockImplementation(() => pending.promise);
    const load = useAgentSkillStore.getState().loadSkills("http://agent.test", "test");
    connect("dsh");
    useAgentSkillStore.getState().selectSkill(skill("native-work"));
    pending.resolve(Response.json({ engineId: "codex", runtimeId: "codex-runtime", data: [skill("wrong-engine")] }));
    await load;
    expect(useAgentSkillStore.getState().skills).toEqual([]);
    expect(useAgentSkillStore.getState().selectedSkill?.name).toBe("native-work");
    expect(useAgentStore.getState().prompt).toBe("/native-work");
});

test("events require current engine and runtime and scoped tool results cannot cross a switch", async () => {
    connect("dsh");
    const previous = getAgentScope();
    expect(acceptsAgentEvent({ engineId: "codex", runtimeId: "dsh-runtime" })).toBe(false);
    expect(acceptsAgentEvent({ engineId: "dsh", runtimeId: "previous-runtime" })).toBe(false);
    expect(acceptsAgentEvent({ engineId: "dsh", runtimeId: "dsh-runtime" })).toBe(true);
    connect("dsh", "restarted-runtime");
    expect(isCurrentAgentScope(previous)).toBe(false);
    const request = spyOn(globalThis, "fetch");
    await expect(postToolResult("http://agent.test", "test", "client", { requestId: "old", result: "do not deliver" }, previous)).rejects.toBeInstanceOf(StaleAgentResponseError);
    expect(request).not.toHaveBeenCalled();
});

test("DSH preserves native user IDs, replaces optimistic messages and materializes stream commits once", () => {
    connect("dsh");
    const pending = scopeChatItem({ id: "pending", itemId: "synthetic:user", clientMessageId: "client-message", role: "user", text: "Hello" }, "same-thread", "");
    const event: DshEvent = { type: "message.completed", engineId: "dsh", runtimeId: "dsh-runtime", threadId: "same-thread", turnId: "run-1", itemId: "native-user", item: { id: "native-user", clientMessageId: "client-message", role: "user", text: "Hello" } };
    let messages = mergeDshEventMessage(bindPendingTurnMessages([pending], "same-thread", "run-1"), event);
    expect(messages).toHaveLength(1);
    expect(messages[0].itemId).toBe("native-user");
    messages = mergeDshEventMessage(messages, { ...event, type: "message.updated", itemId: "attempt", item: { id: "attempt", role: "assistant", text: "Partial" } });
    const committed = { ...event, itemId: "native-assistant", removeItemId: "attempt", item: { id: "native-assistant", role: "assistant" as const, text: "Complete" } };
    messages = mergeDshEventMessage(messages, committed);
    messages = mergeDshEventMessage(messages, committed);
    expect(messages.map((item) => item.itemId)).toEqual(["native-user", "native-assistant"]);
    const otherRuntime = mergeDshEventMessage(messages, { ...committed, runtimeId: "old" });
    expect(otherRuntime).toBe(messages);
    const authoritative = new Set(["same-thread\0run-1"]);
    const live = new Set<string>();
    expect(registerLiveAgentTurn(committed, authoritative, live)).toBe(false);
    expect(registerLiveAgentTurn({ ...committed, replayed: true }, authoritative, live)).toBe(false);
    const history = normalizeHistoryMessages(messages);
    expect(mergeAgentMessages(history, [...messages, scopeChatItem({ id: "extra", role: "assistant", text: "late duplicate" }, "same-thread", "run-1")], "same-thread", live)).toHaveLength(2);
});

test("native reasoning streams remain distinct and abandoned attempts disappear without touching other turns", () => {
    connect("dsh");
    const event: DshEvent = { type: "message.updated", engineId: "dsh", runtimeId: "dsh-runtime", threadId: "same-thread", turnId: "run-1", itemId: "attempt", item: { id: "attempt", role: "assistant", text: "Partial" } };
    let messages = mergeDshEventMessage([], event);
    expect(messages[0].streamId).toBe("attempt");
    messages = mergeDshEventMessage(messages, { ...event, itemId: "attempt:reasoning", item: { id: "attempt:reasoning", role: "reasoning", text: "Native analysis" } });
    expect(messages[1]).toMatchObject({ role: "tool", itemId: "attempt:reasoning", detail: { kind: "reasoning", status: "inProgress" } });
    messages = [...messages, scopeChatItem({ id: "attempt", itemId: "attempt", role: "assistant", text: "Another turn" }, "same-thread", "run-2")];
    messages = mergeDshEventMessage(messages, { ...event, item: undefined, type: "message.withdrawn", removeItemId: "attempt" });
    expect(messages).toHaveLength(1);
    expect(messages[0].turnId).toBe("run-2");
    const history = normalizeHistoryMessages([normalizeDshChatItem({ id: "reasoning", itemId: "reasoning", role: "reasoning", text: "Settled analysis", threadId: "same-thread", turnId: "run-1" })]);
    expect(history[0]).toMatchObject({ role: "tool", itemId: "reasoning", detail: { kind: "reasoning", status: "completed" } });
});

test("native permission and arbitrary provider efforts pass unchanged through scoped APIs", async () => {
    connect("dsh");
    const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ engineId: "dsh", runtimeId: "dsh-runtime", ok: true }));
    await fetchAgentJson("http://agent.test", "test", "/agent/dsh/turn", { method: "POST", body: JSON.stringify({ permissionMode: "native-ask", model: "model", provider: "provider", effort: "native-adaptive" }) });
    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.pathname).toBe("/agent/dsh/turn");
    expect(url.searchParams.get("engineId")).toBe("dsh");
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ permissionMode: "native-ask", model: "model", provider: "provider", effort: "native-adaptive" });
    expect(useAgentStore.getState().engines.find((item) => item.id === "dsh")?.capabilities.permissions[0].id).toBe("native-ask");
});

test("existing DSH settings stay native until explicitly changed and provider routes never collide", () => {
    connect("dsh");
    const providerA = { id: JSON.stringify(["provider-a", "same-model"]), provider: "provider-a", model: "same-model", displayName: "Shared name", defaultReasoningEffort: "native", supportedReasoningEfforts: [{ reasoningEffort: "native" }] };
    const providerB = { ...providerA, id: JSON.stringify(["provider-b", "same-model"]), provider: "provider-b" };
    useAgentStore.getState().setAgentState({ models: [providerA, providerB], model: providerB.id, reasoningEffort: "native", permissionMode: "native-ask" });
    expect(agentTurnSettings(useAgentStore.getState())).toEqual({});
    useAgentStore.getState().setAgentState({ modelChanged: true, permissionChanged: true });
    expect(agentTurnSettings(useAgentStore.getState())).toEqual({ model: "same-model", provider: "provider-b", effort: "native", permissionMode: "native-ask" });
    connect("codex");
    connect("dsh");
    expect(useAgentStore.getState()).toMatchObject({ model: providerB.id, modelChanged: true, permissionChanged: true });
    expect(agentTurnSettings({ ...useAgentStore.getState(), engineId: "codex", permissionMode: "request", modelChanged: false, permissionChanged: false }).permissionMode).toBe("request");
});

test("DSH approval decisions retain native values rather than Codex approval semantics", async () => {
    connect("dsh");
    const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ engineId: "dsh", runtimeId: "dsh-runtime", ok: true }));
    await postAgentApproval("http://agent.test", "test", "approval", "allowed-once");
    expect(new URL(String(request.mock.calls[0][0])).pathname).toBe("/agent/dsh/approval");
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ requestId: "approval", decision: "allowed-once" });
});

test("disconnect invalidates in-flight responses before a same-runtime reconnection", async () => {
    connect("codex");
    const scope = getAgentScope();
    const pending = deferred<Response>();
    spyOn(globalThis, "fetch").mockImplementation(() => pending.promise);
    const request = fetchAgentJson("http://agent.test", "test", "/agent/codex/models");
    useAgentStore.getState().disconnectAgent();
    connect("codex");
    expect(isCurrentAgentScope(scope)).toBe(false);
    pending.resolve(Response.json({ engineId: "codex", runtimeId: "codex-runtime", data: [] }));
    await expect(request).rejects.toBeInstanceOf(StaleAgentResponseError);
});

test("busy activation is rejected without optimistic engine changes and uses the prior runtime identity", async () => {
    connect("codex");
    const pending = deferred<Response>();
    const request = spyOn(globalThis, "fetch").mockImplementation(() => pending.promise);
    const activation = activateAgentEngine("http://agent.test", "test", "dsh", "client");
    expect(useAgentStore.getState().engineId).toBe("codex");
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ clientId: "client", expectedEngineId: "codex", runtimeId: "codex-runtime" });
    pending.resolve(Response.json({ error: "busy", code: "ENGINE_BUSY" }, { status: 409 }));
    await expect(activation).rejects.toBeInstanceOf(AgentApiError);
    expect(useAgentStore.getState().engineId).toBe("codex");
});

test("DSH profile changes send the prior runtime and accept the deliberate replacement without optimistic state", async () => {
    connect("dsh");
    const pending = deferred<Response>();
    const request = spyOn(globalThis, "fetch").mockImplementation(() => pending.promise);
    const activation = switchDshConfigProfile("http://agent.test", "test", "desktop", "client");
    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.pathname).toBe("/agent/engines/dsh/profile");
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ profile: "desktop", clientId: "client", expectedEngineId: "dsh", runtimeId: "dsh-runtime" });
    expect(useAgentStore.getState().runtimeId).toBe("dsh-runtime");
    expect(useAgentStore.getState().engines[1].configProfile).toBe("web");
    const next = { activeEngineId: "dsh", runtimeId: "dsh-desktop-runtime", engine: { ...engines[1], configProfile: "desktop" }, engines: [engines[0], { ...engines[1], configProfile: "desktop" }] };
    pending.resolve(Response.json(next));
    expect(await activation).toEqual(next);
    expect(useAgentStore.getState().engines[1].configProfile).toBe("web");
});

test("failed profile changes retain the source and ordinary scoped responses still reject runtime replacement", async () => {
    connect("dsh");
    spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: "busy", code: "ENGINE_BUSY" }, { status: 409 })).mockResolvedValueOnce(Response.json({ engineId: "dsh", runtimeId: "unrelated-runtime", data: [] }));
    await expect(switchDshConfigProfile("http://agent.test", "test", "desktop", "client")).rejects.toBeInstanceOf(AgentApiError);
    expect(useAgentStore.getState().engines[1].configProfile).toBe("web");
    await expect(fetchAgentJson("http://agent.test", "test", "/agent/dsh/models")).rejects.toBeInstanceOf(StaleAgentResponseError);
});

test("every initialization, approval, draft and stop state blocks engine switching and desktop maintenance", () => {
    connect("dsh");
    const idle = { ...useAgentStore.getState(), sending: false, waiting: false, switchingEngine: false, globalBusy: false, loadingThreads: false, pendingTool: null, pendingApprovals: [], draftingSkill: false, stopping: false };
    expect(agentIsBusy(idle)).toBe(false);
    for (const field of ["sending", "waiting", "switchingEngine", "globalBusy", "loadingThreads", "draftingSkill", "stopping"] as const) expect(agentIsBusy({ ...idle, [field]: true })).toBe(true);
    for (const status of ["preparing", "running"]) expect(agentIsBusy({ ...idle, conversation: { ...idle.conversation, status } })).toBe(true);
    expect(agentIsBusy({ ...idle, pendingApprovals: [{ requestId: "approval" }] })).toBe(true);
    expect(agentIsBusy({ ...idle, pendingTool: { requestId: "tool" } })).toBe(true);
    useAgentSkillStore.getState().setGeneratingSource("canvas");
    expect(agentIsBusy(useAgentStore.getState())).toBe(true);
    useAgentSkillStore.getState().reset();
    expect(useAgentStore.getState().draftingSkill).toBe(false);
});

test("message previews route to the owning engine with authenticated runtime scope", () => {
    connect("dsh");
    const url = new URL(resolveAgentMessageAssetUrl("http://agent.test", "test", `agent-asset:${"a".repeat(64)}/${"b".repeat(64)}.png`));
    expect(url.pathname.startsWith("/agent/dsh/message-assets/")).toBe(true);
    expect(url.searchParams.get("engineId")).toBe("dsh");
    expect(url.searchParams.get("runtimeId")).toBe("dsh-runtime");
    expect(url.searchParams.get("token")).toBe("test");
});

test("tool cancellation clears only the matching current request and releases its busy state", () => {
    connect("dsh");
    const pending = { requestId: "waiting-tool", name: "canvas_apply_ops", engineId: "dsh", runtimeId: "dsh-runtime", threadId: "same-thread", turnId: "run-1" };
    const cancelled = { ...pending, reason: "aborted" };
    useAgentStore.getState().setAgentState({ pendingTool: pending });
    expect(agentIsBusy(useAgentStore.getState())).toBe(true);
    for (const mismatch of [{ requestId: "previous-tool" }, { engineId: "codex" }, { runtimeId: "previous-runtime" }, { threadId: "another-thread" }, { turnId: "run-0" }]) {
        expect(cancelPendingAgentTool(pending, { ...cancelled, ...mismatch })).toBe(pending);
    }
    const next = cancelPendingAgentTool(pending, cancelled);
    expect(next).toBeNull();
    useAgentStore.getState().setAgentState({ pendingTool: next });
    expect(agentIsBusy(useAgentStore.getState())).toBe(false);
    const newer = { ...pending, requestId: "new-tool" };
    expect(cancelPendingAgentTool(newer, cancelled)).toBe(newer);
    expect(cancelPendingAgentTool(null, cancelled)).toBeNull();
    connect("codex");
    expect(cancelPendingAgentTool(pending, cancelled)).toBe(pending);
});

test("native DSH image-only user, assistant and tool histories retain authenticated preview sources", () => {
    connect("dsh");
    const logicalPath = "/agent/dsh/native-attachments/native-session/image-id";
    const attachment = { id: "image-id", name: "native.png", type: "image/png", size: 12, width: 24, height: 48, url: logicalPath };
    for (const role of ["user", "assistant", "tool"] as const) {
        const history = normalizeHistoryMessages([{ id: role, itemId: role, threadId: "native-session", turnId: "native-turn", role, text: "", attachments: [attachment] }]);
        expect(history).toHaveLength(1);
        expect(history[0].attachments).toEqual([attachment]);
        const rendered = agentMessageToChatMessage(history[0], "http://agent.test/", "token +/=?");
        const url = new URL(rendered.attachments![0].url);
        expect(url.origin).toBe("http://agent.test");
        expect(url.pathname).toBe(logicalPath);
        expect(url.searchParams.get("token")).toBe("token +/=?");
        expect(url.searchParams.get("engineId")).toBe("dsh");
        expect(url.searchParams.get("runtimeId")).toBe("dsh-runtime");
    }
    const event: DshEvent = { type: "tool.completed", engineId: "dsh", runtimeId: "dsh-runtime", threadId: "native-session", turnId: "native-turn", itemId: "tool", item: { id: "tool", role: "tool", text: "", attachments: [attachment] } };
    const live = mergeDshEventMessage([], event);
    expect(agentMessageToChatMessage(live[0], "http://agent.test", "test").attachments![0].url).toContain(`${logicalPath}?`);
});

test("native DSH attachment paths are scoped without authorizing other paths or engines", () => {
    connect("dsh");
    const prefix = "/agent/dsh/native-attachments/";
    const path = `${prefix}${encodeURIComponent("native session")}/${encodeURIComponent("图片-id")}`;
    const url = new URL(resolveAgentMessageAssetUrl("http://agent.test/base", "test", path));
    expect(url.pathname).toBe(`/base${path}`);
    expect(resolveAgentMessageAssetUrl("http://agent.test", "", path)).toBe("");
    expect(resolveAgentMessageAssetUrl("http://agent.test", "test", `${prefix}session/../image`)).toBe("");
    expect(resolveAgentMessageAssetUrl("http://agent.test", "test", `${prefix}%2e%2e/image`)).toBe("");
    expect(resolveAgentMessageAssetUrl("http://agent.test", "test", `${prefix}session/image?remote=1`)).toBe("");
    expect(resolveAgentMessageAssetUrl("http://agent.test", "test", "https://images.test/reference.png")).toBe("https://images.test/reference.png");
    connect("codex");
    expect(resolveAgentMessageAssetUrl("http://agent.test", "test", path)).toBe("");
});
