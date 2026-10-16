import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import type { AgentConversationState } from "../../src/stores/use-agent-store";
import type { AgentEngine, DshConfigProfile } from "../../src/lib/agent/agent-engine";

const browser = new Window({ url: "http://canvas.test/canvas/test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "SVGElement", "Node", "ShadowRoot", "Event", "MouseEvent", "MessageEvent", "MutationObserver", "ResizeObserver", "localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : browser[name] });
}
for (const name of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: browser[name].bind(browser) });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

// Image/site tools are unrelated to engine selection and would hydrate business stores.
const unused = () => { throw new Error("Unexpected image or site tool call"); };
mock.module(fileURLToPath(new URL("../../src/services/image-storage.ts", import.meta.url)), () => ({ uploadImage: unused, imageToDataUrl: unused }));
mock.module(fileURLToPath(new URL("../../src/lib/agent/agent-site-tools.ts", import.meta.url)), () => ({ isSiteTool: () => false, runSiteTool: unused, SITE_TOOL_LABELS: {} }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App, ConfigProvider } = await import("antd");
const { MemoryRouter } = await import("react-router-dom");
const { LocalAgentPanel } = await import("../../src/components/agent/local-agent-panel");
const { useAgentStore } = await import("../../src/stores/use-agent-store");
const { useAgentSkillStore } = await import("../../src/stores/use-agent-skill-store");
const { getAgentScope } = await import("../../src/lib/agent/agent-engine");
const { default: i18n } = await import("../../src/i18n");

const engines: AgentEngine[] = ["codex", "dsh"].map((id) => ({
    id: id as AgentEngine["id"], name: id === "codex" ? "Codex" : "DSH",
    ...(id === "dsh" ? { configProfile: "web" as const } : {}),
    capabilities: { permissions: [], skills: true, attachments: true, manageSettings: false },
}));
let activeEngineId: "codex" | "dsh" = "codex";
let runtimeId = "codex-runtime";
let conversation: AgentConversationState = { revision: 1, conversationId: "initial", threadId: "", status: "preparing", mcpStatuses: { docs: { status: "starting" } } };
let globalBusy = true;
const catalog = () => ({ activeEngineId, engineId: activeEngineId, runtimeId, engines, globalBusy });
const response = (body: object) => Response.json({ ...catalog(), ...body });
const activations: Array<{ pathname: string; body: unknown }> = [];
const pendingHistories: Array<{ resolve: (response: Response) => void; body: object }> = [];
const pendingDshReads: Array<{ resolve: (response: Response) => void; body: object }> = [];
const profileChanges: Array<{ resolve: (response: Response) => void; body: unknown }> = [];
const runtimeRequests: Array<{ path: string; runtimeId: string | null }> = [];
const desktopModel = { id: "desktop-model", model: "desktop-model", provider: "desktop-provider", displayName: "Desktop model", defaultReasoningEffort: "native", supportedReasoningEfforts: [{ reasoningEffort: "native" }], isDefault: true };
const desktopSkill = { name: "desktop-skill", description: "Desktop skill", path: "/desktop/SKILL.md", scope: "user", enabled: true, managed: true };

class FakeEventSource extends browser.EventTarget {
    static instances: FakeEventSource[] = [];
    closed = false;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        super();
        FakeEventSource.instances.push(this);
        queueMicrotask(() => this.emit("hello", { ok: true, protocolVersion: 7, ...catalog(), conversation, workspace: { activeThreadId: conversation.threadId }, codex: { busy: false, threadId: conversation.threadId, turnId: "" }, pendingApprovals: [] }));
    }
    close() { this.closed = true; }
    emit(type: string, body: object) {
        if (!this.closed) this.dispatchEvent(new browser.MessageEvent(type, { data: JSON.stringify({ ...catalog(), ...body }) }));
    }
}
Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://agent.test", "Tests must never contact a real Agent");
    const path = url.pathname;
    runtimeRequests.push({ path, runtimeId: url.searchParams.get("runtimeId") });
    if (path === "/config") return response({ ok: true, url: "http://agent.test", token: "test-token" });
    if (path === "/agent/engines") return response({});
    if (path.endsWith("/models") || path.endsWith("/skills")) {
        const models = path.endsWith("/models");
        if (activeEngineId === "dsh" && runtimeId === "dsh-runtime") {
            const body = { ...catalog(), data: models ? [{ ...desktopModel, id: "stale-web-model", model: "stale-web-model" }] : [{ ...desktopSkill, name: "stale-web-skill" }] };
            return await new Promise<Response>((resolve) => pendingDshReads.push({ resolve, body }));
        }
        return response({ data: activeEngineId === "dsh" ? models ? [desktopModel] : [desktopSkill] : [] });
    }
    if (path.endsWith("/threads")) {
        const body = { ...catalog(), workspace: { workspacePath: "/test-workspace", activeThreadId: conversation.threadId }, conversation: structuredClone(conversation), data: activeEngineId === "dsh" ? [{ id: "dsh-thread", preview: "Preserved native history" }] : [] };
        if (activeEngineId === "codex") return await new Promise<Response>((resolve) => pendingHistories.push({ resolve, body }));
        return response(body);
    }
    if (path === "/agent/engines/dsh/activate") {
        activations.push({ pathname: path, body: JSON.parse(String(init?.body)) });
        activeEngineId = "dsh";
        runtimeId = "dsh-runtime";
        globalBusy = false;
        conversation = { revision: 1, conversationId: "dsh-session", threadId: "dsh-thread", status: "ready", mcpStatuses: {} };
        return response({ engine: engines[1], conversation, workspace: { workspacePath: "/test-workspace", activeThreadId: "dsh-thread" } });
    }
    if (path === "/agent/engines/dsh/profile") return await new Promise<Response>((resolve) => profileChanges.push({ resolve, body: JSON.parse(String(init?.body)) }));
    if (path.startsWith("/agent/dsh/threads/")) return response({ messages: [], settledTurnIds: [], historyReady: true });
    if (path === "/canvas/state" || path === "/canvas/activate") return response({ ok: true });
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${path}`);
}) as typeof fetch;

async function flush(run: () => void | Promise<void> = () => {}) {
    await act(async () => { await run(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function until(condition: () => boolean, label: string) {
    for (let step = 0; step < 60 && !condition(); step++) await flush();
    assert.ok(condition(), `${label}; state=${JSON.stringify({ engineId: useAgentStore.getState().engineId, loadingThreads: useAgentStore.getState().loadingThreads, conversation: useAgentStore.getState().conversation.status, globalBusy: useAgentStore.getState().globalBusy })}`);
}
const source = () => FakeEventSource.instances.findLast((item) => !item.closed)!;
const trigger = () => browser.document.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("agentEngines.select")}"]`)!;
const profileSelect = () => browser.document.querySelector<HTMLInputElement>("#dsh-config-profile")!;
const connectionToggle = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t(`agent.connect.${useAgentStore.getState().enabled ? "disconnect" : "connect"}`))!;
const profileText = () => profileSelect().closest(".ant-select")!.textContent;
async function openProfileOptions() {
    await flush(() => profileSelect().closest(".ant-select")!.dispatchEvent(new browser.MouseEvent("mousedown", { bubbles: true })));
    await until(() => browser.document.querySelectorAll(".ant-select-item-option").length > 0, "DSH configuration source options must open");
}
const profileOption = (profile: DshConfigProfile) => [...browser.document.querySelectorAll<HTMLElement>(".ant-select-item-option")].find((item) => item.textContent === i18n.t(`agentEngines.${profile === "web" ? "webProfile" : "desktopProfile"}`))!;
function changeServerProfile(profile: DshConfigProfile, nextRuntimeId: string) {
    engines[1] = { ...engines[1], configProfile: profile };
    runtimeId = nextRuntimeId;
    conversation = { revision: 1, conversationId: `${nextRuntimeId}-conversation`, threadId: `${nextRuntimeId}-thread`, status: "ready", mcpStatuses: {} };
    return { ...catalog(), engine: engines[1], conversation, workspace: { workspacePath: "/test-workspace", activeThreadId: conversation.threadId } };
}
const host = browser.document.createElement("div");
browser.document.body.append(host);
const root = createRoot(host as unknown as HTMLElement);

try {
    useAgentStore.getState().setAgentState({ url: "http://agent.test", token: "test-token", enabled: true, connected: false, activeTab: "setup" });
    await flush(() => root.render(<MemoryRouter><ConfigProvider theme={{ token: { motion: false } }}><App><LocalAgentPanel embedded /></App></ConfigProvider></MemoryRouter>));
    await until(() => FakeEventSource.instances.length >= 2 && useAgentStore.getState().connected && pendingHistories.length > 0, "First hello must establish runtime, recreate SSE and load history");
    assert.equal(FakeEventSource.instances[0].closed, true);
    assert.equal(getAgentScope().runtimeId, "codex-runtime");
    assert.equal(trigger().disabled, true, "Preparing must block switching");
    const initializingText = i18n.t("agentEngines.initializing", { engine: "Codex" });
    assert.equal(host.querySelector('[role="status"]')?.textContent, initializingText, "Connection settings must explain why a connected engine cannot switch");

    // MCP services can be terminal while thread creation is still preparing.
    conversation = { ...conversation, revision: 2, mcpStatuses: { docs: { status: "failed", error: "fixture failure" }, canvas: { status: "ready" } } };
    await flush(() => source().emit("conversation_changed", conversation));
    assert.equal(useAgentStore.getState().conversation.status, "preparing");
    assert.equal(trigger().disabled, true);
    assert.equal(host.querySelector('[role="status"]')?.textContent, initializingText, "Terminal MCP statuses must not hide ongoing thread initialization");
    await flush(() => trigger().parentElement!.dispatchEvent(new browser.MouseEvent("mouseover", { bubbles: true })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(browser.document.querySelector('[role="tooltip"]')?.textContent, initializingText, "Hovering the disabled engine control must explain initialization");
    await flush(() => trigger().parentElement!.dispatchEvent(new browser.MouseEvent("mouseout", { bubbles: true })));

    // Successful draft preparation invalidates the pending list without reloading it.
    conversation = { ...conversation, revision: 3, threadId: "codex-thread", status: "warning" };
    globalBusy = false;
    await flush(() => {
        source().emit("conversation_changed", conversation);
        source().emit("workspace_changed", { activeThreadId: "codex-thread", emptyThread: true, draftThread: true, conversation });
        source().emit("agent_state", { busy: false, globalBusy: false, threadId: "codex-thread", turnId: "" });
    });
    assert.equal(useAgentStore.getState().loadingThreads, true);
    await flush(() => { for (const pending of pendingHistories.splice(0)) pending.resolve(Response.json(pending.body)); });
    await until(() => !trigger().disabled, "Terminal preparation and invalidated history must release the real menu");
    assert.equal(useAgentStore.getState().conversation.status, "warning");
    assert.equal(useAgentStore.getState().globalBusy, false);
    assert.equal(host.querySelector('[role="status"]'), null, "Initialization explanation must disappear when ready");

    await flush(() => trigger().click());
    await until(() => [...browser.document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === "DSH"), "Real Ant Design dropdown must open");
    const dsh = [...browser.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "DSH")!;
    await flush(() => dsh.click());
    await until(() => useAgentStore.getState().engineId === "dsh" && trigger().textContent?.includes("DSH") === true && !trigger().disabled, "Click must activate and render DSH");
    assert.equal(activations.length, 1);
    assert.equal(activations[0].pathname, "/agent/engines/dsh/activate");
    assert.deepEqual(activations[0].body, { clientId: browser.sessionStorage.getItem("canvas-agent-client-id"), expectedEngineId: "codex", runtimeId: "codex-runtime" });
    await until(() => profileSelect() !== null && pendingDshReads.length >= 2, "DSH connection settings must show the server source while native lists are pending");
    assert.ok(profileText()?.includes(i18n.t("agentEngines.webProfile")));
    assert.ok(host.textContent?.includes(i18n.t("agentEngines.configProfileDescription")));

    // Every shared busy state disables the real Select, including an already-open option.
    const idle = useAgentStore.getState();
    for (const field of ["sending", "waiting", "switchingEngine", "globalBusy", "loadingThreads", "draftingSkill", "stopping"] as const) {
        await flush(() => useAgentStore.getState().setAgentState({ [field]: true }));
        assert.equal(profileSelect().disabled, true, `${field} must block profile switching`);
        await flush(() => useAgentStore.getState().setAgentState({ [field]: false }));
    }
    for (const status of ["preparing", "running"] as const) {
        await flush(() => useAgentStore.getState().setAgentState({ conversation: { ...idle.conversation, status } }));
        assert.equal(profileSelect().disabled, true, `${status} must block profile switching`);
    }
    await flush(() => useAgentStore.getState().setAgentState({ conversation: idle.conversation, pendingTool: { requestId: "pending", name: "canvas_apply_ops" } }));
    assert.equal(profileSelect().disabled, true);
    await flush(() => useAgentStore.getState().setAgentState({ pendingTool: null, pendingApprovals: [{ requestId: "approval", method: "native" }] }));
    assert.equal(profileSelect().disabled, true);
    await flush(() => useAgentStore.getState().setAgentState({ pendingApprovals: [] }));
    await openProfileOptions();
    const desktopOption = profileOption("desktop");
    await flush(() => useAgentStore.getState().setAgentState({ globalBusy: true }));
    await flush(() => desktopOption.click());
    assert.equal(profileChanges.length, 0, "A stale open option must not bypass busy guards");
    await flush(() => useAgentStore.getState().setAgentState({ globalBusy: false, model: "web-provider-model", modelChanged: true, permissionMode: "web-permission", permissionChanged: true, reasoningEffort: "web-effort", prompt: "Keep my draft" }));

    await openProfileOptions();
    await flush(() => profileOption("desktop").click());
    await until(() => profileChanges.length === 1, "Clicking Desktop must request the profile change");
    assert.deepEqual(profileChanges[0].body, { profile: "desktop", clientId: browser.sessionStorage.getItem("canvas-agent-client-id"), expectedEngineId: "dsh", runtimeId: "dsh-runtime" });
    assert.equal(useAgentStore.getState().runtimeId, "dsh-runtime");
    assert.ok(profileText()?.includes(i18n.t("agentEngines.webProfile")), "Source must remain server-authoritative while switching");
    assert.equal(profileSelect().disabled, true);
    assert.equal(trigger().disabled, true, "Profile and engine switches must share one transition guard");

    // SSE can confirm the new runtime before the HTTP response returns.
    const desktopResult = changeServerProfile("desktop", "dsh-desktop-runtime");
    await flush(() => source().emit("engine_changed", desktopResult));
    await until(() => useAgentStore.getState().runtimeId === "dsh-desktop-runtime" && useAgentStore.getState().models[0]?.id === desktopModel.id && useAgentSkillStore.getState().skills[0]?.name === desktopSkill.name, "New runtime must reload native models and skills");
    assert.ok(profileText()?.includes(i18n.t("agentEngines.desktopProfile")));
    assert.equal(useAgentStore.getState().modelChanged, false);
    assert.equal(useAgentStore.getState().permissionChanged, false);
    assert.equal(useAgentStore.getState().permissionMode, "");
    assert.equal(useAgentStore.getState().prompt, "Keep my draft");
    assert.equal(useAgentStore.getState().activeThreadId, "dsh-desktop-runtime-thread");
    assert.equal(useAgentStore.getState().threads[0]?.id, "dsh-thread", "Old native conversations remain in history");
    for (const path of ["/agent/dsh/models", "/agent/dsh/skills", "/agent/dsh/threads"]) assert.ok(runtimeRequests.some((request) => request.path === path && request.runtimeId === "dsh-desktop-runtime"), `${path} must use the new runtime`);
    await flush(() => {
        profileChanges[0].resolve(Response.json(desktopResult));
        for (const pending of pendingDshReads.splice(0)) pending.resolve(Response.json(pending.body));
    });
    await until(() => !profileSelect().disabled, "Profile transition must settle after matching HTTP confirmation");
    assert.deepEqual(useAgentStore.getState().models.map((item) => item.id), [desktopModel.id]);
    assert.deepEqual(useAgentSkillStore.getState().skills.map((item) => item.name), [desktopSkill.name]);

    // A response from a superseded transition must not overwrite another tab's runtime.
    await openProfileOptions();
    await flush(() => profileOption("web").click());
    await until(() => profileChanges.length === 2, "Web source must also be selectable");
    const lateWebResult = changeServerProfile("web", "obsolete-web-runtime");
    const latestDesktopResult = changeServerProfile("desktop", "latest-desktop-runtime");
    await flush(() => source().emit("engine_changed", latestDesktopResult));
    await flush(() => profileChanges[1].resolve(Response.json(lateWebResult)));
    await until(() => !profileSelect().disabled, "Superseded transition must release its guard");
    assert.equal(useAgentStore.getState().runtimeId, "latest-desktop-runtime");
    assert.ok(profileText()?.includes(i18n.t("agentEngines.desktopProfile")), "Late HTTP profile data must not replace the latest server event");

    // A pre-disconnect HTTP response cannot release a newer local profile operation.
    await openProfileOptions();
    await flush(() => profileOption("web").click());
    await until(() => profileChanges.length === 3, "First profile operation must remain pending before disconnect");
    const preDisconnectResult = changeServerProfile("web", "pre-disconnect-web-runtime");
    await flush(() => connectionToggle().click());
    await until(() => !useAgentStore.getState().enabled && !useAgentStore.getState().connected, "Disconnect must end the old operation ownership");
    await flush(() => connectionToggle().click());
    await until(() => useAgentStore.getState().connected && !profileSelect().disabled && useAgentStore.getState().runtimeId === "pre-disconnect-web-runtime", "Reconnect must load the active source without the old operation lock");
    await openProfileOptions();
    await flush(() => profileOption("desktop").click());
    await until(() => profileChanges.length === 4, "New profile operation must start after reconnect");
    await flush(() => profileChanges[2].resolve(Response.json(preDisconnectResult)));
    assert.equal(useAgentStore.getState().switchingEngine, true, "The old response must not release the newer local operation's lock");
    assert.equal(profileSelect().disabled, true);
    assert.equal(trigger().disabled, true);
    const reconnectedDesktopResult = changeServerProfile("desktop", "post-reconnect-desktop-runtime");
    await flush(() => profileChanges[3].resolve(Response.json(reconnectedDesktopResult)));
    await until(() => useAgentStore.getState().runtimeId === "post-reconnect-desktop-runtime" && !profileSelect().disabled, "Only the owning profile response may release the new operation lock");
    assert.ok(profileText()?.includes(i18n.t("agentEngines.desktopProfile")));

    // Startup failures still belong to the chosen source after SSE rotates scope.
    await openProfileOptions();
    await flush(() => profileOption("web").click());
    await until(() => profileChanges.length === 5, "A failed source must remain reviewable");
    const failedResult = changeServerProfile("web", "failed-web-runtime");
    conversation = { ...conversation, status: "failed", error: "Fixture DSH startup failed" };
    failedResult.conversation = conversation;
    await flush(() => source().emit("engine_changed", failedResult));
    await flush(() => profileChanges[4].resolve(Response.json({ engineId: "dsh", runtimeId, error: conversation.error }, { status: 500 })));
    await until(() => !profileSelect().disabled, "Failed source startup must release the switch guard");
    assert.equal(useAgentStore.getState().runtimeId, "failed-web-runtime");
    assert.ok(profileText()?.includes(i18n.t("agentEngines.webProfile")));
    assert.equal(host.querySelector('[role="alert"]')?.textContent, conversation.error, "Connection settings must display the startup failure after a source switch");
    assert.ok([...browser.document.querySelectorAll(".ant-message-error")].some((item) => item.textContent === conversation.error), "Matching target failure must remain visible even if SSE arrived first");
    console.log("Agent menu DOM regression passed");
    console.log("DSH profile DOM regression passed");
} finally {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
}
