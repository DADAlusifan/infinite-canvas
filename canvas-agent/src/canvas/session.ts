import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

import type { AgentAttachment } from "../agent/types.js";
import { CODEX_ENGINE, type AgentEngineDescriptor, type AgentEngineId, type AgentScope } from "../agent/engine.js";
import { logger } from "../utils/logger.js";
import { buildCanvasToolRequest, fitAttachmentNodeSize } from "./operations.js";
import type { ToolName } from "./schemas.js";
import { compactCanvasState, compactNode, isToolName, nextCanvasX, parseToolInput } from "./tools.js";
import type { CanvasSnapshot } from "./types.js";

type PendingRequest = AgentScope & { clientId: string; threadId: string; turnId: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
type TurnAttachment = { clientId: string; id: string; name: string; type: string; size: number; width: number; height: number; dataUrl: string };
type ReplayEvent = { type: string; payload: Record<string, unknown> };
export type AgentRunState = { busy: boolean; threadId: string; turnId: string };
export type McpStartupState = "starting" | "ready" | "failed" | "cancelled";
export type ConversationState = {
    revision: number;
    conversationId: string;
    threadId: string;
    status: "idle" | "preparing" | "ready" | "warning" | "running" | "failed";
    mcpStatuses: Record<string, { status: McpStartupState; error?: string | null; failureReason?: string | null }>;
    sourceClientId?: string;
    error?: string;
};
type McpInventoryItem = { name: string; authStatus?: string };
export const AGENT_PROTOCOL_VERSION = 7;

const SITE_TOOLS = new Set<ToolName>([
    "site_navigate",
    "canvas_list_projects",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
    "generation_get_status",
]);

/** 管理网页画布连接、状态、附件和工具请求。 */
export class CanvasSession {
    private activeEngineId: AgentEngineId = "codex";
    private runtimeIds = { codex: crypto.randomUUID(), dsh: crypto.randomUUID() };
    private engines: AgentEngineDescriptor[] = [CODEX_ENGINE];
    private engineStates = new Map<AgentEngineId, { conversation: ConversationState; run: AgentRunState }>();
    private clients = new Map<string, ServerResponse>();
    private clientFocusOrder = new Map<string, number>();
    private pending = new Map<string, PendingRequest>();
    private pendingApprovals = new Map<string, Record<string, unknown>>();
    private canvasStates = new Map<string, CanvasSnapshot>();
    private turnAttachments = new Map<string, TurnAttachment>();
    private replayEvents = new Map<string, ReplayEvent>();
    private replayActiveItems = new Set<string>();
    private mutationBusy = false;
    private activeClientId = "";
    private boundClientId = "";
    private focusSequence = 0;
    private agentState: AgentRunState = { busy: false, threadId: "", turnId: "" };
    private conversationState: ConversationState;
    private conversationInventoryComplete = false;
    private preparedConversationThreadId = "";

    constructor(activeThreadId = "") {
        this.conversationState = {
            revision: 1,
            conversationId: activeThreadId || crypto.randomUUID(),
            threadId: activeThreadId,
            status: activeThreadId ? "ready" : "idle",
            mcpStatuses: {},
        };
    }

    /** 获取当前目标网页的画布状态。 */
    private get canvasState() {
        return this.clients.has(this.targetClientId) ? this.canvasStates.get(this.targetClientId) || null : null;
    }

    /** 获取当前 turn 绑定或最近激活的网页客户端。 */
    private get targetClientId() {
        return this.boundClientId || this.activeClientId;
    }

    /** 返回 Canvas Agent 当前连接状态。 */
    health() {
        return { ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, ...this.engineSnapshot, hasCanvas: Boolean(this.canvasState), clients: this.clients.size, conversation: this.conversationStateSnapshot };
    }

    get scope(): AgentScope { return { engineId: this.activeEngineId, runtimeId: this.runtimeIds[this.activeEngineId] }; }
    runtimeFor(engineId: AgentEngineId) { return this.runtimeIds[engineId]; }
    get globalBusy() { return this.agentState.busy || this.mutationBusy || this.pending.size > 0 || this.pendingApprovals.size > 0 || this.conversationState.status === "preparing"; }
    get engineSnapshot() {
        return { ...this.scope, activeEngineId: this.activeEngineId, engines: this.engines, engine: this.engines.find((engine) => engine.id === this.activeEngineId), globalBusy: this.globalBusy };
    }
    setEngineDescriptors(engines: AgentEngineDescriptor[]) { this.engines = engines; }

    restartDshRuntime() {
        if (this.activeEngineId !== "dsh" || this.agentState.busy || this.pending.size || this.pendingApprovals.size) throw new Error("请先等待当前 DSH 任务和审批完成");
        this.runtimeIds.dsh = crypto.randomUUID();
        this.engineStates.delete("dsh");
        this.agentState = { busy: false, threadId: "", turnId: "" };
        this.conversationInventoryComplete = false;
        this.preparedConversationThreadId = "";
        this.conversationState = { revision: 1, conversationId: crypto.randomUUID(), threadId: "", status: "idle", mcpStatuses: {} };
        this.replayEvents.clear();
        this.replayActiveItems.clear();
        this.boundClientId = "";
        this.turnAttachments.clear();
    }

    /** The coordinator serializes activation; never carry approvals or live tools across engines. */
    selectEngine(engineId: AgentEngineId, threadId = "") {
        if (this.agentState.busy || this.pending.size || this.pendingApprovals.size) throw new Error("请先等待当前 Agent 任务和审批完成");
        if (engineId === this.activeEngineId) return;
        this.engineStates.set(this.activeEngineId, { conversation: this.conversationStateSnapshot, run: this.runStateSnapshot });
        this.activeEngineId = engineId;
        const saved = this.engineStates.get(engineId);
        this.agentState = saved?.run || { busy: false, threadId, turnId: "" };
        this.conversationState = saved?.conversation || {
            revision: 0, conversationId: threadId || crypto.randomUUID(), threadId, status: "idle", mcpStatuses: {},
        };
        this.pendingApprovals.clear();
        this.replayEvents.clear();
        this.replayActiveItems.clear();
        this.boundClientId = "";
        this.turnAttachments.clear();
    }

    matchesScope(scope: { engineId?: unknown; runtimeId?: unknown }) {
        return (!scope.engineId || scope.engineId === this.scope.engineId) && (!scope.runtimeId || scope.runtimeId === this.scope.runtimeId);
    }

    private envelope(payload: unknown) { return { ...recordValue(payload), ...this.scope }; }

    /** 返回当前引擎是否正在执行任务。 */
    get agentBusy() {
        return this.agentState.busy;
    }

    get agentThreadId() {
        return this.agentState.threadId;
    }

    /** Return a copy that callers restore after an isolated skill-draft operation. */
    get runStateSnapshot(): AgentRunState {
        return { ...this.agentState };
    }

    /** 返回站点级对话的权威快照。 */
    get conversationStateSnapshot(): ConversationState {
        return { ...this.conversationState, mcpStatuses: { ...this.conversationState.mcpStatuses } };
    }

    /** 原子开始一次新建或恢复对话流程。 */
    beginConversation(options: { threadId?: string; conversationId?: string; sourceClientId?: string } = {}) {
        this.conversationInventoryComplete = false;
        this.preparedConversationThreadId = "";
        return this.updateConversation({
            conversationId: options.conversationId || options.threadId || crypto.randomUUID(),
            threadId: options.threadId || "",
            status: "preparing",
            mcpStatuses: {},
            sourceClientId: options.sourceClientId,
            error: undefined,
        });
    }

    /** 记录预热阶段单个 MCP 服务的启动状态。 */
    updateConversationMcp(name: string, status: McpStartupState, error?: string | null, failureReason?: string | null) {
        if (!name || this.conversationState.status !== "preparing") return this.conversationStateSnapshot;
        const snapshot = this.updateConversation({
            mcpStatuses: { ...this.conversationState.mcpStatuses, [name]: { status, error, failureReason } },
        });
        return this.conversationInventoryComplete && this.preparedConversationThreadId
            ? this.completeConversationPreparation(this.preparedConversationThreadId)
            : snapshot;
    }

    /** 用 app-server 的完整 MCP 清单补齐未发送逐项通知的服务。 */
    completeConversationMcpInventory(services: McpInventoryItem[]) {
        if (this.conversationState.status !== "preparing") return this.conversationStateSnapshot;
        const mcpStatuses = { ...this.conversationState.mcpStatuses };
        services.filter((item) => item.name).forEach((item) => {
            const current = mcpStatuses[item.name];
            if (current?.status === "failed" || current?.status === "cancelled") return;
            mcpStatuses[item.name] = item.authStatus === "notLoggedIn"
                ? { status: "failed", error: "MCP 服务未登录", failureReason: "reauthenticationRequired" }
                : { status: "ready" };
        });
        this.conversationInventoryComplete = true;
        return this.updateConversation({ mcpStatuses });
    }

    /** MCP 清单读取结束后提交线程和最终可发送状态。 */
    completeConversationPreparation(threadId: string) {
        this.preparedConversationThreadId = threadId;
        const statuses = this.conversationState.mcpStatuses;
        const hasPending = !this.conversationInventoryComplete || Object.values(statuses).some((item) => item.status === "starting");
        const requiredFailure = statuses["infinite-canvas"]?.status !== "ready";
        const hasFailure = Object.values(statuses).some((item) => item.status === "failed" || item.status === "cancelled");
        const requiredFailureDetail = statuses["infinite-canvas"]?.error;
        return this.updateConversation({
            threadId,
            status: hasPending ? "preparing" : requiredFailure ? "failed" : hasFailure ? "warning" : "ready",
            error: requiredFailure ? `Infinite Canvas MCP 初始化失败${requiredFailureDetail ? `：${requiredFailureDetail}` : ""}` : undefined,
        });
    }

    /** 将创建线程或读取 MCP 清单的失败保存为不可发送状态。 */
    failConversationPreparation(error: string) {
        this.conversationInventoryComplete = false;
        this.preparedConversationThreadId = "";
        return this.updateConversation({ status: "failed", error });
    }

    /** 切换到无需重新预热的既有状态，例如删除当前对话后的空状态。 */
    activateConversation(threadId: string, sourceClientId?: string) {
        this.conversationInventoryComplete = false;
        this.preparedConversationThreadId = "";
        return this.updateConversation({
            conversationId: threadId || crypto.randomUUID(),
            threadId,
            status: threadId ? "ready" : "idle",
            mcpStatuses: {},
            sourceClientId,
            error: undefined,
        });
    }

    markConversationRunning(threadId: string) {
        if (!threadId || threadId !== this.conversationState.threadId || !["ready", "warning"].includes(this.conversationState.status)) return this.conversationStateSnapshot;
        return this.updateConversation({ status: "running" });
    }

    finishConversationRun(threadId: string) {
        if (!threadId || threadId !== this.conversationState.threadId) return this.conversationStateSnapshot;
        const hasFailure = Object.values(this.conversationState.mcpStatuses).some((item) => item.status === "failed" || item.status === "cancelled");
        return this.updateConversation({ status: hasFailure ? "warning" : "ready" });
    }

    /** 判断网页客户端是否仍连接到当前 Agent。 */
    hasClient(clientId: string) {
        return this.clients.has(clientId);
    }

    /** 读取指定网页上报的画布，避免提炼时受最近焦点或其他标签页影响。 */
    canvasStateForClient(clientId: string) {
        return this.clients.has(clientId) ? this.canvasStates.get(clientId) || null : null;
    }

    /** 原子取得写操作权限，避免跨引擎或多网页交叉修改会话。 */
    beginMutation() {
        if (this.agentState.busy || this.mutationBusy || this.pendingApprovals.size || this.pending.size || this.conversationState.status === "preparing") return false;
        this.mutationBusy = true;
        this.emitAll("agent_state", { ...this.agentState, globalBusy: true });
        return true;
    }

    /** 释放当前写操作权限。 */
    endMutation() {
        this.mutationBusy = false;
        this.emitAll("agent_state", { ...this.agentState, globalBusy: this.globalBusy });
    }

    /** 返回当前 turn 的线程、turn 和发起网页。 */
    get eventScope() {
        return {
            threadId: this.agentState.threadId,
            turnId: this.agentState.busy ? this.agentState.turnId : "",
            sourceClientId: this.agentState.busy ? this.boundClientId : "",
        };
    }

    /** 返回刷新后仍需展示的权限请求。 */
    get pendingApprovalSnapshot() {
        return [...this.pendingApprovals.values()];
    }

    /** 跟踪需要跨页面重连恢复的权限请求。 */
    trackEvent(type: string, payload: Record<string, unknown>) {
        const previous = this.pendingApprovals.size;
        const requestId = String(payload.requestId || "");
        if ((type === "codex_approval" || type === "dsh_approval") && requestId) this.pendingApprovals.set(requestId, payload);
        if ((type === "codex_approval_resolved" || type === "dsh_approval_resolved") && requestId) this.pendingApprovals.delete(requestId);
        if (type === "agent_error") this.pendingApprovals.clear();
        if (this.pendingApprovals.size !== previous) this.emitAll("agent_state", { ...this.agentState, globalBusy: this.globalBusy });
    }

    /** 更新运行状态；独立后台活动可保留上一 turn 的断线重放。 */
    setRunState(patch: Partial<AgentRunState>, options: { preserveReplay?: boolean } = {}) {
        const next = { ...this.agentState, ...patch };
        const threadChanged = next.threadId !== this.agentState.threadId;
        const turnChanged = Boolean(this.agentState.turnId && next.turnId && next.turnId !== this.agentState.turnId);
        const nextTurnStarted = !this.agentState.busy && next.busy;
        if (!options.preserveReplay && (threadChanged || turnChanged || nextTurnStarted)) {
            this.replayEvents.clear();
            this.replayActiveItems.clear();
        }
        if (!next.busy) {
            if (this.boundClientId && !this.clients.has(this.boundClientId)) this.boundClientId = "";
        }
        if (next.busy === this.agentState.busy && next.threadId === this.agentState.threadId && next.turnId === this.agentState.turnId) return;
        this.agentState = next;
        logger.debug("Agent state changed", { ...this.agentState, ...this.scope });
        this.emitAll(this.activeEngineId === "codex" ? "codex_state" : "agent_state", { ...this.agentState, globalBusy: this.globalBusy });
    }

    /** 权威历史已覆盖指定 turn 后，清理其断线重放事件。 */
    acknowledgeHistory(threadId: string, turnIds: string[]) {
        const acknowledged = new Set(turnIds.filter(Boolean));
        if (!threadId || !acknowledged.size) return;
        this.replayEvents.forEach((event, key) => {
            const eventThreadId = String(event.payload.threadId || event.payload.thread_id || "");
            const eventTurnId = String(event.payload.turnId || event.payload.turn_id || "");
            if (eventThreadId === threadId && acknowledged.has(eventTurnId)) {
                this.replayEvents.delete(key);
                this.replayActiveItems.delete(key);
            }
        });
    }

    /** 建立网页与 Canvas Agent 之间的 SSE 连接。 */
    openEvents(url: URL, res: ServerResponse, activeThreadId = "") {
        const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
        const statusOnly = url.searchParams.get("role") === "status";
        logger.info("SSE client connected", { clientId, statusOnly });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        if (!statusOnly) {
            this.clients.set(clientId, res);
            if (!this.clientFocusOrder.has(clientId)) this.clientFocusOrder.set(clientId, 0);
            if (!this.activeClientId) {
                this.activeClientId = clientId;
                this.clientFocusOrder.set(clientId, ++this.focusSequence);
            }
        }
        sendEvent(res, "hello", { ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, ...this.engineSnapshot, clientId, workspace: { activeThreadId }, conversation: this.conversationStateSnapshot, codex: this.agentState, pendingApprovals: this.pendingApprovalSnapshot });
        if (!statusOnly && activeThreadId && this.agentState.threadId === activeThreadId) this.replayEvents.forEach((event) => sendEvent(res, event.type, event.payload));
        const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
        res.on("close", () => {
            clearInterval(timer);
            logger.info("SSE client disconnected", { clientId, statusOnly });
            if (statusOnly || this.clients.get(clientId) !== res) return;
            this.clients.delete(clientId);
            this.clientFocusOrder.delete(clientId);
            this.canvasStates.delete(clientId);
            this.pending.forEach((item, requestId) => {
                if (item.clientId !== clientId) return;
                this.pending.delete(requestId);
                item.reject(new Error("请求页面已断开"));
            });
            if (this.activeClientId === clientId) this.activeClientId = [...this.clients.keys()].sort((a, b) => (this.clientFocusOrder.get(b) || 0) - (this.clientFocusOrder.get(a) || 0))[0] || "";
        });
    }

    private updateConversation(patch: Partial<Omit<ConversationState, "revision">>) {
        const wasBusy = this.globalBusy;
        this.conversationState = { ...this.conversationState, ...patch, revision: this.conversationState.revision + 1 };
        const snapshot = this.conversationStateSnapshot;
        this.emitAll("conversation_changed", snapshot);
        if (wasBusy !== this.globalBusy) this.emitAll("agent_state", { ...this.agentState, globalBusy: this.globalBusy });
        return snapshot;
    }

    /** 保存指定网页上报的最新画布快照。 */
    updateState(body: unknown, clientId?: string) {
        const targetClientId = clientId || this.activeClientId;
        if (!targetClientId || !this.clients.has(targetClientId)) return;
        const state = { ...((body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>), clientId: targetClientId } as CanvasSnapshot;
        this.canvasStates.set(targetClientId, state);
        logger.debug("Canvas state updated", { clientId: targetClientId, nodes: state.nodes?.length || 0, connections: state.connections?.length || 0 });
    }

    /** 将指定网页设为最近激活的工具目标。 */
    activateClient(clientId: string) {
        if (!this.clients.has(clientId)) throw new Error("当前网页未连接");
        this.activeClientId = clientId;
        this.clientFocusOrder.set(clientId, ++this.focusSequence);
        logger.debug("Canvas client activated", { clientId });
    }

    /** 将当前 Agent turn 固定绑定到指定网页。 */
    bindClient(clientId: string) {
        if (!this.clients.has(clientId)) throw new Error("当前网页未连接");
        this.boundClientId = clientId;
        logger.debug("Canvas client bound to turn", { clientId });
    }

    /** 解除当前 Agent turn 的网页绑定。 */
    releaseClient(clientId: string) {
        if (this.boundClientId === clientId) this.boundClientId = "";
        logger.debug("Canvas client released from turn", { clientId });
    }

    /** 保存当前 turn 可用的图片附件并返回安全引用。 */
    setTurnAttachments(clientId: string, attachments: AgentAttachment[]) {
        this.turnAttachments.clear();
        return attachments.flatMap((item, index) => {
            if (!item.dataUrl?.startsWith("data:image/")) return [];
            const id = item.id?.trim() || `attachment-${crypto.randomUUID()}`;
            const attachment: TurnAttachment = {
                clientId,
                id,
                name: item.name?.trim() || `图片 ${index + 1}`,
                type: item.type?.startsWith("image/") ? item.type : item.dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png",
                size: positiveNumber(item.size, 0),
                width: positiveNumber(item.width, 1024),
                height: positiveNumber(item.height, 1024),
                dataUrl: item.dataUrl,
            };
            this.turnAttachments.set(id, attachment);
            return [{ id, name: attachment.name, type: attachment.type, size: attachment.size, width: attachment.width, height: attachment.height }];
        });
    }

    /** 清理指定网页或全部 turn 附件。 */
    clearTurnAttachments(clientId?: string) {
        this.turnAttachments.forEach((item, id) => {
            if (!clientId || item.clientId === clientId) this.turnAttachments.delete(id);
        });
    }

    /** 获取属于指定网页 turn 的图片附件。 */
    getTurnAttachment(clientId: string, attachmentId: string) {
        const attachment = this.turnAttachments.get(attachmentId);
        if (!attachment) throw new Error(`找不到本轮图片附件：${attachmentId}`);
        if (attachment.clientId !== clientId) throw new Error("图片附件不属于当前 turn 的发起标签页");
        return attachment;
    }

    /** 接收网页返回的工具调用结果。 */
    resolveResult(clientId: string, body: { requestId?: string; error?: string; result?: unknown }) {
        const item = body.requestId ? this.pending.get(body.requestId) : null;
        if (!item || !body.requestId || item.clientId !== clientId || !this.matchesScope(item) || item.threadId !== this.agentState.threadId || item.turnId !== this.agentState.turnId) return false;
        this.pending.delete(body.requestId);
        this.emitAll("agent_state", { ...this.agentState, globalBusy: this.globalBusy });
        logger.debug("Canvas tool result received", { clientId, requestId: body.requestId, error: body.error, result: body.result });
        body.error ? item.reject(new Error(body.error)) : item.resolve(body.result);
        return true;
    }

    /** 向全部已连接网页广播事件。 */
    emitAll(type: string, payload: unknown) {
        if (!this.matchesScope(recordValue(payload))) return;
        this.clients.forEach((client) => sendEvent(client, type, this.envelope(payload)));
    }

    /** 向全部网页广播带线程归属的事件。 */
    emitThread(type: string, threadId: string, payload: Record<string, unknown> = {}) {
        if (!this.matchesScope(payload)) return;
        const data: Record<string, unknown> = this.envelope({ ...payload, threadId });
        const replayKey = agentReplayKey(type, data);
        const eventTurnId = String(data.turnId || data.turn_id || "");
        const currentScope = threadId === this.agentState.threadId && (!this.agentState.turnId || !eventTurnId || eventTurnId === this.agentState.turnId);
        if (this.agentState.busy && currentScope && replayKey) {
            const item = recordValue(data.item);
            const eventType = String(data.type || "");
            if (type === "agent_event" && item.id && (eventType === "item.started" || eventType === "item.updated")) this.replayActiveItems.add(replayKey);
            if (type === "agent_event" && item.id && eventType === "item.completed") this.replayActiveItems.delete(replayKey);
            if (type === "agent_event" && (eventType === "turn.completed" || eventType === "error")) this.clearReplayActiveTurn(threadId, eventTurnId);
            const replayData = this.replaySnapshot(replayKey, data);
            this.replayEvents.set(replayKey, { type, payload: { ...replayData, replayed: true } });
            while (this.replayEvents.size > 240) {
                const evictable = [...this.replayEvents.keys()].find((key) => !this.replayActiveItems.has(key));
                if (!evictable) break;
                this.replayEvents.delete(evictable);
            }
        }
        this.emitAll(type, data);
    }

    /** 为断线重连保存完整的最新文本快照，实时连接仍只接收增量。 */
    private replaySnapshot(replayKey: string, data: Record<string, unknown>) {
        if (data.type !== "item.updated" && data.type !== "item.completed") return data;
        const item = recordValue(data.item);
        if (!item.id) return data;
        const previous = recordValue(recordValue(this.replayEvents.get(replayKey)?.payload).item);
        const delta = String(item.delta || "");
        if (!delta) return data;
        const previousText = String(previous.text || "");
        const { delta: _delta, ...snapshotItem } = item;
        return { ...data, item: { ...previous, ...snapshotItem, text: `${previousText}${delta}` } };
    }

    private clearReplayActiveTurn(threadId: string, turnId: string) {
        const prefix = `item:${turnId}:`;
        this.replayActiveItems.forEach((key) => {
            if (key.startsWith(prefix)) this.replayActiveItems.delete(key);
        });
        if (!turnId) return;
        this.replayActiveItems.forEach((key) => {
            const event = this.replayEvents.get(key);
            const eventThreadId = String(event?.payload.threadId || event?.payload.thread_id || "");
            const eventTurnId = String(event?.payload.turnId || event?.payload.turn_id || "");
            if (eventThreadId === threadId && eventTurnId === turnId) this.replayActiveItems.delete(key);
        });
    }

    /** 校验工具参数并将调用分派到当前目标网页。 */
    async callTool(name: unknown, rawInput: unknown, options: { scope?: Partial<AgentScope>; signal?: AbortSignal } = {}) {
        if (options.scope && !this.matchesScope(options.scope)) throw new Error("工具调用来自已失效的 Agent 运行实例");
        options.signal?.throwIfAborted();
        if (!isToolName(name)) throw new Error(`未知工具：${String(name)}`);
        logger.info("MCP tool called", { name, input: rawInput, targetClientId: this.targetClientId });
        const input = parseToolInput(name, rawInput) as Record<string, unknown>;
        if (SITE_TOOLS.has(name)) {
            if (!this.clients.size) throw new Error("当前没有已连接网页");
            return await this.requestCanvasTool(name, input, options.signal);
        }
        const readTool = ["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot"].includes(name);
        if (readTool && (!this.clients.size || !this.canvasState)) throw new Error("当前没有已连接画布");
        if (name === "canvas_get_state" || name === "canvas_export_snapshot") return compactCanvasState(this.canvasState);
        if (name === "canvas_get_selection") {
            const ids = new Set(this.canvasState?.selectedNodeIds || []);
            return { nodes: (this.canvasState?.nodes || []).filter((node) => ids.has(node.id)).map(compactNode) };
        }
        if (name === "canvas_create_attachment_nodes") return await this.createAttachmentNodes(input as { attachmentIds: string[]; x?: number; y?: number; gap?: number; direction?: "row" | "column" }, options.signal);
        if (!this.clients.size) throw new Error("当前没有已连接画布");
        const request = buildCanvasToolRequest(name, input, this.canvasState);
        return await this.requestCanvasTool(request.name, request.input, options.signal);
    }

    /** 将当前 turn 的附件转换为画布图片节点。 */
    private async createAttachmentNodes(input: { attachmentIds: string[]; x?: number; y?: number; gap?: number; direction?: "row" | "column" }, signal?: AbortSignal) {
        const clientId = this.targetClientId;
        if (!this.clients.has(clientId)) throw new Error("当前没有已连接画布");
        const attachments = input.attachmentIds.map((id) => this.getTurnAttachment(clientId, id));
        const x = Number(input.x ?? nextCanvasX(this.canvasState));
        const y = Number(input.y ?? 0);
        const gap = Number(input.gap ?? 40);
        const direction = input.direction || "row";
        let offset = 0;
        const nodes = attachments.map((attachment) => {
            const size = fitAttachmentNodeSize(attachment.width, attachment.height);
            const node = {
                id: `image-${crypto.randomUUID()}`,
                attachmentId: attachment.id,
                title: attachment.name,
                position: { x: direction === "row" ? x + offset : x, y: direction === "column" ? y + offset : y },
                width: size.width,
                height: size.height,
            };
            offset += (direction === "row" ? size.width : size.height) + gap;
            return node;
        });
        await this.requestCanvasTool("canvas_create_attachment_nodes", { nodes }, signal);
        return { nodes: nodes.map(({ id, attachmentId, title }) => ({ id, attachmentId, title })) };
    }

    /** 向目标网页发送工具请求并等待调用结果。 */
    private async requestCanvasTool(name: ToolName, input: Record<string, unknown>, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const requestId = crypto.randomUUID();
        const clientId = this.targetClientId;
        const client = this.clients.get(clientId);
        if (!client) throw new Error("当前没有已连接画布");
        logger.debug("Canvas tool request sent", { requestId, name, input, clientId });
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                logger.warn("Canvas tool request timed out", { requestId, name, clientId });
                this.rejectToolRequest(requestId, new Error("画布操作超时"));
            }, 30000);
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
            const abort = () => {
                this.rejectToolRequest(requestId, signal?.reason instanceof Error ? signal.reason : new Error("工具调用已取消"));
            };
            this.pending.set(requestId, {
                clientId, ...this.scope, threadId: this.agentState.threadId, turnId: this.agentState.turnId,
                resolve: (value) => { cleanup(); resolve(value); },
                reject: (error) => { cleanup(); reject(error); },
            });
            this.emitAll("agent_state", { ...this.agentState, globalBusy: this.globalBusy });
            signal?.addEventListener("abort", abort, { once: true });
            sendEvent(client, "tool_call", this.envelope({ requestId, name, input, threadId: this.agentState.threadId, turnId: this.agentState.turnId }));
        });
    }

    cancelPendingTools(reason = "当前 Agent 任务已结束") {
        this.pending.forEach((_pending, id) => this.rejectToolRequest(id, new Error(reason)));
    }

    private rejectToolRequest(requestId: string, error: Error) {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        this.emitAll("agent_state", { ...this.agentState, globalBusy: this.globalBusy });
        const client = this.clients.get(pending.clientId);
        if (client) sendEvent(client, "tool_cancelled", {
            requestId, reason: error.message, engineId: pending.engineId, runtimeId: pending.runtimeId,
            threadId: pending.threadId, turnId: pending.turnId,
        });
        pending.reject(error);
    }
}

/** 为运行中 turn 的可重放事件生成稳定键。 */
function agentReplayKey(type: string, payload: Record<string, unknown>) {
    const turnId = String(payload.turnId || payload.turn_id || "");
    if (type === "chat_message") {
        const message = recordValue(payload.message);
        const clientMessageId = String(message.clientMessageId || "");
        if (clientMessageId) return `chat:${clientMessageId}`;
        const messageId = String(message.itemId || message.id || "");
        return messageId ? `chat:${turnId}:${messageId}` : "";
    }
    if (type === "agent_error") return `error:${turnId}`;
    if (type !== "agent_event" && type !== "dsh_event") return "";
    const item = recordValue(payload.item);
    if (item.id) return `item:${turnId}:${String(item.id)}`;
    const eventType = String(payload.type || "");
    if (eventType === "plan.updated") return `plan:${turnId}`;
    if (eventType === "usage.updated") return `usage:${turnId}`;
    if (eventType === "turn.completed" || eventType === "error") return `${eventType}:${turnId}`;
    return "";
}

function recordValue(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 向 SSE 连接写入一个事件。 */
function sendEvent(res: ServerResponse, type: string, payload: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
/** 将未知数值转换为正数，否则使用默认值。 */
function positiveNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}
