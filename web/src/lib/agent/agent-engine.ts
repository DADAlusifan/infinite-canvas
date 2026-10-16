export type AgentEngineId = "codex" | "dsh";
export type DshConfigProfile = "web" | "desktop";
export type AgentPermissionPreset = { id: string; title: string; description: string };
export type AgentEngine = {
    id: AgentEngineId;
    name: string;
    configProfile?: DshConfigProfile;
    capabilities: { permissions: AgentPermissionPreset[]; defaultPermissionMode?: string; skills: boolean; attachments: boolean; manageSettings: boolean };
};
export type AgentScope = { engineId: AgentEngineId; runtimeId: string; revision: number };

let scope: AgentScope = { engineId: "codex", runtimeId: "", revision: 0 };

export function getAgentScope() { return scope; }
export function invalidateAgentScope() { scope = { ...scope, revision: scope.revision + 1 }; }
export function setAgentScope(engineId: AgentEngineId, runtimeId: string) {
    if (scope.engineId !== engineId || scope.runtimeId !== runtimeId) scope = { engineId, runtimeId, revision: scope.revision + 1 };
    return scope;
}
export function isCurrentAgentScope(expected: AgentScope) {
    return expected.engineId === scope.engineId && expected.runtimeId === scope.runtimeId && expected.revision === scope.revision;
}
export function acceptsAgentEvent(event: { engineId?: string; runtimeId?: string }, expected = scope) {
    return isCurrentAgentScope(expected) && event.engineId === expected.engineId && event.runtimeId === expected.runtimeId;
}
export type AgentToolIdentity = { requestId: string; engineId?: string; runtimeId?: string; threadId?: string; turnId?: string };
export function cancelPendingAgentTool<T extends AgentToolIdentity>(pending: T | null, cancelled: AgentToolIdentity): T | null {
    if (!pending || !acceptsAgentEvent(cancelled) || pending.requestId !== cancelled.requestId) return pending;
    for (const field of ["engineId", "runtimeId", "threadId", "turnId"] as const) if (pending[field] && pending[field] !== cancelled[field]) return pending;
    return null;
}
export class StaleAgentResponseError extends Error {
    constructor() { super("引擎已切换，已忽略先前响应"); this.name = "StaleAgentResponseError"; }
}
export function enginePreferenceKey(engineId: AgentEngineId, field: string) { return `infinite-canvas:agent:${engineId}:${field}`; }
export function agentSkillMarker(engineId: AgentEngineId, name: string) { return `${engineId === "dsh" ? "/" : "$"}${name}`; }
export function agentIsBusy(state: { sending: boolean; waiting: boolean; switchingEngine: boolean; globalBusy: boolean; loadingThreads: boolean; pendingTool: unknown; pendingApprovals: unknown[]; draftingSkill: boolean; stopping: boolean; conversation: { status: string } }) {
    return state.sending || state.waiting || state.switchingEngine || state.globalBusy || state.loadingThreads || Boolean(state.pendingTool) || state.pendingApprovals.length > 0 || state.draftingSkill || state.stopping || ["preparing", "running"].includes(state.conversation.status);
}
