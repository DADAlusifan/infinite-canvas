import i18n from "@/i18n";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { AgentReasoningEffort, AgentStore } from "@/stores/use-agent-store";
import { getAgentScope, isCurrentAgentScope, StaleAgentResponseError, type AgentEngine, type AgentEngineId, type AgentScope, type DshConfigProfile } from "@/lib/agent/agent-engine";

export type AgentEngineCatalog = { activeEngineId: AgentEngineId; runtimeId: string; engines: AgentEngine[]; globalBusy?: boolean };
export type AgentEngineActivation = AgentEngineCatalog & { engine: AgentEngine; workspace?: { workspacePath: string; activeThreadId?: string }; conversation?: import("@/stores/use-agent-store").AgentConversationState };
export function fetchAgentEngines(endpoint: string, token: string) { return fetchAgentJson<AgentEngineCatalog>(endpoint, token, "/agent/engines"); }
export function activateAgentEngine(endpoint: string, token: string, engineId: AgentEngineId, clientId: string) {
    const scope = getAgentScope();
    return fetchAgentJson<AgentEngineActivation>(endpoint, token, `/agent/engines/${engineId}/activate`, jsonPost({ clientId, expectedEngineId: scope.engineId, runtimeId: scope.runtimeId }));
}
export function switchDshConfigProfile(endpoint: string, token: string, profile: DshConfigProfile, clientId: string) {
    const scope = getAgentScope();
    return fetchAgentJson<AgentEngineActivation>(endpoint, token, "/agent/engines/dsh/profile", jsonPost({ profile, clientId, expectedEngineId: scope.engineId, runtimeId: scope.runtimeId }));
}
export function openAgentSettings(endpoint: string, token: string) { return fetchAgentJson(endpoint, token, `${agentEnginePath()}/settings/open`, jsonPost({})); }
export function agentEnginePath() { return `/agent/${getAgentScope().engineId}`; }
export function agentTurnSettings(state: Pick<AgentStore, "engineId" | "permissionMode" | "permissionChanged" | "model" | "modelChanged" | "models" | "reasoningEffort">) {
    const selected = state.models.find((item) => (item.id || item.model) === state.model);
    return {
        ...(state.permissionMode && (state.engineId === "codex" || state.permissionChanged) ? { permissionMode: state.permissionMode } : {}),
        ...(state.engineId === "codex" || state.modelChanged ? { model: selected?.model || state.model, provider: selected?.provider, ...(state.reasoningEffort ? { effort: state.reasoningEffort } : {}) } : {}),
    };
}

type AgentConfigResponse = { ok?: boolean; protocolVersion?: number; url?: string; token?: string; hasToken?: boolean };
const AGENT_MESSAGE_ASSET_PATTERN = /^agent-asset:([a-f0-9]{64})\/([a-f0-9]{64}\.(?:gif|jpe?g|png|webp))$/;
const DSH_NATIVE_ATTACHMENT_PREFIX = "/agent/dsh/native-attachments/";
const DSH_NATIVE_ATTACHMENT_PATTERN = /^\/agent\/dsh\/native-attachments\/([^/?#\\]+)\/([^/?#\\]+)$/;

export class AgentApiError<T = unknown> extends Error {
    constructor(readonly status: number, readonly response: T & { code?: string; error?: string; msg?: string }) {
        super(response.error || response.msg || i18n.t("agent.state.requestFailed"));
        this.name = "AgentApiError";
    }
}

export type AgentSkillScope = "user" | "repo" | "system" | "admin";
export type AgentSkillInterface = { displayName?: string | null; shortDescription?: string | null; defaultPrompt?: string | null };
export type AgentSkillSummary = {
    name: string;
    description: string;
    shortDescription?: string | null;
    interface?: AgentSkillInterface | null;
    dependencies?: unknown;
    path: string;
    scope: AgentSkillScope;
    enabled: boolean;
    managed: boolean;
    revision?: string;
};
export type AgentSkillDetail = {
    name: string;
    description: string;
    instructions: string;
    interface?: AgentSkillInterface | null;
    path: string;
    managed: true;
    revision: string;
};
export type AgentSkillInput = { name?: string; description: string; instructions: string; interface?: AgentSkillInterface | null; expectedRevision?: string };
export type AgentSkillDraft = { name: string; displayName: string; description: string; instructions: string; shortDescription: string; defaultPrompt: string };
export type AgentSkillDraftInput = { source: "conversation" | "canvas"; threadId: string; clientId: string; model?: string; provider?: string; effort?: AgentReasoningEffort };
export type AgentSkillsResponse = { ok?: boolean; data?: AgentSkillSummary[]; errors?: unknown[] };
export type AgentSkillResponse = { ok?: boolean; data?: AgentSkillDetail };
export type AgentSkillDraftResponse = { ok?: boolean; data?: AgentSkillDraft };

export async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null) {
    try {
        const response = await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function activateAgentClient(endpoint: string, token: string, clientId: string) {
    try {
        await fetch(`${endpoint}/canvas/activate?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST" });
    } catch {}
}

export async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }, scope = getAgentScope()) {
    if (!isCurrentAgentScope(scope)) throw new StaleAgentResponseError();
    await fetchAgentJson(endpoint, token, `/canvas/result?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export async function postAgentApproval(endpoint: string, token: string, requestId: string, decision: string) {
    await fetchAgentJson(endpoint, token, `${agentEnginePath()}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, decision }) });
}

export async function interruptAgentTurn(endpoint: string, token: string, threadId?: string) {
    await fetchAgentJson(endpoint, token, `${agentEnginePath()}/interrupt`, jsonPost({ threadId }));
}

export async function acknowledgeAgentHistory(endpoint: string, token: string, threadId: string, turnIds: string[]) {
    await fetchAgentJson(endpoint, token, `${agentEnginePath()}/history/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, turnIds }) });
}

export async function revealAgentLocalFile(endpoint: string, token: string, path: string) {
    await fetchAgentJson(endpoint, token, "/agent/local-file/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
}

export function resolveAgentMessageAssetUrl(endpoint: string, token: string, value: string) {
    const match = AGENT_MESSAGE_ASSET_PATTERN.exec(value);
    const baseUrl = endpoint.trim().replace(/\/$/, "");
    const scope = getAgentScope();
    if (value.startsWith(DSH_NATIVE_ATTACHMENT_PREFIX)) {
        const native = DSH_NATIVE_ATTACHMENT_PATTERN.exec(value);
        if (!native || scope.engineId !== "dsh" || !baseUrl || !token) return "";
        try {
            const ids = native.slice(1).map(decodeURIComponent);
            if (ids.some((id) => id === "." || id === ".." || /[/\\]/.test(id))) return "";
            return `${baseUrl}${DSH_NATIVE_ATTACHMENT_PREFIX}${ids.map(encodeURIComponent).join("/")}?${new URLSearchParams({ token, engineId: scope.engineId, runtimeId: scope.runtimeId })}`;
        } catch { return ""; }
    }
    if (!match) return value.startsWith("agent-asset:") ? "" : value;
    return baseUrl && token ? `${baseUrl}/agent/${scope.engineId}/message-assets/${match[1]}/${match[2]}?${new URLSearchParams({ token, engineId: scope.engineId, runtimeId: scope.runtimeId })}` : "";
}

export function fetchAgentSkills(endpoint: string, token: string, forceReload = false) {
    return fetchAgentJson<AgentSkillsResponse>(endpoint, token, `${agentEnginePath()}/skills${forceReload ? "?forceReload=1" : ""}`);
}

export function fetchAgentSkill(endpoint: string, token: string, name: string) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, `${agentEnginePath()}/skills/${encodeURIComponent(name)}`);
}

export function createAgentSkill(endpoint: string, token: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, `${agentEnginePath()}/skills`, jsonPost(input));
}

export function createAgentSkillDraft(endpoint: string, token: string, input: AgentSkillDraftInput) {
    return fetchAgentJson<AgentSkillDraftResponse>(endpoint, token, `${agentEnginePath()}/skills/draft`, jsonPost(input));
}

export function updateAgentSkill(endpoint: string, token: string, name: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, `${agentEnginePath()}/skills/${encodeURIComponent(name)}`, jsonPost(input));
}

export function deleteAgentSkill(endpoint: string, token: string, name: string, expectedRevision: string) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `${agentEnginePath()}/skills/${encodeURIComponent(name)}/delete`, jsonPost({ expectedRevision }));
}

export async function setAgentSkillEnabled(endpoint: string, token: string, skill: Pick<AgentSkillSummary, "name" | "path" | "revision">, enabled: boolean) {
    const scope = getAgentScope();
    const expectedRevision = skill.revision || (scope.engineId === "dsh" ? (await fetchAgentSkill(endpoint, token, skill.name)).data?.revision : undefined);
    if (!isCurrentAgentScope(scope)) throw new StaleAgentResponseError();
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `${agentEnginePath()}/skills/${encodeURIComponent(skill.name)}/enabled`, jsonPost({ ...skill, enabled, expectedRevision }));
}

export async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const scoped = /^\/agent\/(codex|dsh)(?:\/|$)/.test(path) || path.startsWith("/canvas/result");
    const scope: AgentScope | null = scoped ? getAgentScope() : null;
    const query = new URLSearchParams({ token, ...(scope ? { engineId: scope.engineId, runtimeId: scope.runtimeId } : {}) });
    const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}${query}`;
    try {
        const res = await fetch(url, init);
        const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string; engineId?: string; runtimeId?: string };
        if (scope && (!isCurrentAgentScope(scope) || data.engineId !== scope.engineId || data.runtimeId !== scope.runtimeId)) throw new StaleAgentResponseError();
        if (!res.ok) throw new AgentApiError(res.status, data);
        return data;
    } catch (error) {
        if (scope && !isCurrentAgentScope(scope)) throw new StaleAgentResponseError();
        throw error;
    }
}

export async function discoverAgentConfig(endpoint: string) {
    try {
        const res = await fetch(`${endpoint}/config`);
        if (!res.ok) return null;
        const data = (await res.json()) as AgentConfigResponse;
        return data.ok ? data : null;
    } catch {
        return null;
    }
}

function jsonPost(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
