import { preferences } from "@/services/storage/preferences";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Dropdown, Tooltip } from "antd";
import dayjs from "dayjs";
import { Bot, ChevronDown, History, MessageSquare, PanelRightClose, PlugZap, Plus, Settings, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { readAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { acceptsAgentEvent, agentIsBusy, cancelPendingAgentTool, enginePreferenceKey, getAgentScope, invalidateAgentScope, isCurrentAgentScope, StaleAgentResponseError, type AgentEngineId, type AgentToolIdentity, type DshConfigProfile } from "@/lib/agent/agent-engine";
import { canvasThemes } from "@/lib/canvas-theme";
import { upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { readImageMeta } from "@/lib/image-utils";
import { randomId } from "@/lib/utils";
import { uploadImage } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useShallow } from "zustand/react/shallow";
import { useAgentStore, type AgentAttachment, type AgentBootstrapStatus, type AgentCanvasContext, type AgentCanvasReference, type AgentChatItem, type AgentConversationState, type AgentModel, type AgentPendingApproval, type AgentPendingToolCall, type AgentPermissionMode, type AgentReasoningEffort, type AgentThreadSummary } from "@/stores/use-agent-store";
import { type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import { acknowledgeAgentHistory, activateAgentClient, activateAgentEngine, agentTurnSettings, AgentApiError, discoverAgentConfig, fetchAgentJson, fetchAgentEngines, interruptAgentTurn, openAgentSettings, postAgentApproval, postState, postToolResult, switchDshConfigProfile, type AgentEngineActivation, type AgentEngineCatalog } from "@/services/api/canvas-agent";
import { AgentChatTimeline, AgentTaskProgress, AgentUsageBar } from "./agent-chat";
import { AgentChatComposer } from "./agent-chat-composer";
import { AgentConnectView } from "./agent-connect-view";
import {
    activityDeltaFallback,
    activityDetail,
    activityKind,
    activityPlaceholder,
    agentAttachmentToChatAttachment,
    agentErrorView,
    attachmentPayloadBytes,
    compactText,
    eventUsage,
    formatAgentActivity,
    formatAgentEvent,
    formatAgentEventLog,
    formatAgentPlan,
    formatBytes,
    bindPendingTurnMessages,
    isCanvasWriteTool,
    isConnectionErrorMessage,
    isCurrentThreadEvent,
    isReasoningSummary,
    mergeAgentMessages,
    mergeStreamText,
    normalizeHistoryMessages,
    normalizeText,
    parseEventData,
    promptWithAttachments,
    promptWithCanvasReferences,
    reasoningActivityText,
    registerLiveAgentTurn,
    scopeChatItem,
    stringText,
    toolName,
    turnPlanStatus,
    upsertAgentMessage,
    type AgentEventItem,
    type AgentEventPayload,
} from "./agent-event-formatters";
import { AgentHistoryView } from "./agent-history-view";
import { AgentLogView } from "./agent-log-view";
import { AgentPanelTabs } from "./agent-panel-tabs";
import { AgentSkillsView } from "./agent-skills-view";
import { mergeDshEventMessage, normalizeDshChatItem, type DshEvent } from "./agent-dsh-events";

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 28 * 1024 * 1024;
const MESSAGE_PREVIEW_LONG_EDGE = 192;
const MESSAGE_PREVIEW_MAX_LENGTH = 500_000;
const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";
const AGENT_PROTOCOL_VERSION = 7;
const HISTORY_RETRY_DELAYS_MS = [0, 150, 350, 700, 1200];
const rt = (key: string, options?: Record<string, unknown>) => {
    if (key === "codexRunning" || key === "waitingCodexApproval") return i18n.t(`agentEngines.${key === "codexRunning" ? "running" : "waitingApproval"}`, { engine: useAgentStore.getState().engineId === "dsh" ? "DSH" : "Codex" });
    if (key === "agentNotFound") return i18n.t("agentEngines.agentNotFound");
    return i18n.t(`agent.runtime.${key}`, options);
};

type AgentWorkspace = { workspacePath: string; activeThreadId?: string };
type AgentThreadsResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; data?: AgentThreadSummary[] };
type AgentThreadResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; thread?: AgentThreadSummary; messages?: AgentChatItem[]; settledTurnIds?: string[]; historyReady?: boolean };
type AgentWorkspaceResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState };
type AgentTurnResponse = { ok?: boolean; threadId?: string };
type AgentModelsResponse = { ok?: boolean; data?: AgentModel[] };
type AgentCodexState = { busy?: boolean; globalBusy?: boolean; threadId?: string; turnId?: string };
type AgentHelloEvent = AgentEngineCatalog & { engineId: AgentEngineId; ok?: boolean; protocolVersion?: number; clientId?: string; workspace?: { activeThreadId?: string }; conversation?: AgentConversationState; codex?: AgentCodexState; agent?: AgentCodexState; pendingApprovals?: AgentPendingApproval[] };
type AgentWorkspaceEvent = { activeThreadId?: string; threadId?: string; sourceClientId?: string; emptyThread?: boolean; draftThread?: boolean; conversation?: AgentConversationState };
type AgentChatEvent = { threadId?: string; turnId?: string; sourceClientId?: string; replayed?: boolean; message?: AgentChatItem };
type AgentBootstrapEvent = { type?: "codex.preparing" | "codex.prepare_failed" | "mcp.startup" | "mcp.complete"; phase?: "preheat" | "runtime"; threadId?: string; name?: string; status?: "starting" | "ready" | "failed" | "cancelled"; error?: string | null; failureReason?: string | null };
type AgentClientGlobal = typeof globalThis & { __infiniteCanvasAgentClientIdPromise?: Promise<string> };

function authoritativeHistoryTurnKeys(threadId: string, settledTurnIds: string[]) {
    return new Set(settledTurnIds.map((turnId) => `${threadId}\0${turnId}`));
}

function agentErrorState(error: unknown) {
    return error instanceof AgentApiError ? (error.response as { state?: AgentConversationState }).state : undefined;
}

function conversationBootstrapView(conversation: AgentConversationState) {
    const mcpStartupStatuses: Record<string, AgentBootstrapStatus> = Object.fromEntries(Object.entries(conversation.mcpStatuses).map(([name, item]) => {
        const view: AgentBootstrapStatus = item.status === "starting"
            ? { key: `mcp:${name}:starting`, text: rt("mcpStarting", { name }), detail: rt("mcpConnecting"), status: "running" }
            : item.status === "ready"
                ? { key: `mcp:${name}:ready`, text: rt("mcpReadyNamed", { name }), detail: rt("toolsReady"), status: "ready" }
                : { key: `mcp:${name}:${item.status}`, text: rt(item.status === "failed" ? "mcpFailedNamed" : "mcpCanceledNamed", { name }), detail: item.error || rt("toolInitFailed"), status: "error" };
        return [name, view];
    }));
    const services = Object.values(mcpStartupStatuses);
    const pending = services.filter((item) => item.status === "running").length;
    const bootstrapStatus: AgentBootstrapStatus | null = conversation.status === "idle" || conversation.status === "preparing"
        ? services.length
            ? { key: "mcp:starting", text: rt("mcpServicesStarting"), detail: pending ? rt("toolServicesPending", { count: pending }) : rt("checkingToolServices"), status: "running" }
            : { key: "codex:preparing", text: rt("conversationInitializing"), detail: rt("conversationCreating"), status: "running" }
        : conversation.status === "warning"
            ? { key: "mcp:warning", text: rt("someMcpFailed"), detail: rt("remainingToolsReady"), status: "error" }
            : conversation.status === "failed"
                ? { key: "codex:prepare_failed", text: rt("conversationInitFailed"), detail: conversation.error || rt("conversationCreateFailed"), status: "error" }
                : conversation.status === "ready"
                    ? { key: "mcp:ready", text: rt("mcpServicesReady", { count: services.length }), detail: rt("toolsReady"), status: "ready" }
                    : null;
    return { bootstrapStatus, mcpStartupStatuses };
}

export function LocalAgentPanel({ embedded, headless, autoConnect }: { embedded?: boolean; headless?: boolean; autoConnect?: boolean }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const { hash } = useLocation();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    // Field-level selectors with useShallow rerender only when these fields change.
    // canvasContext is intentionally excluded because project updates it every frame during dragging and resizing.
    // The panel uses it only for ref synchronization and debounced postState calls, never during rendering.
    // Subscribing here would rerender the panel every frame and amplify the #185 crash, so it is observed imperatively below.
    const { engineId, runtimeId, engines, switchingEngine, engineBusy, width, url, token, connected, enabled, prompt, attachments, sending, waiting, tokenUsage, eventLogs, threads, activeThreadId, workspacePath, loadingThreads, activeTab, confirmTools, permissionMode, models, model, reasoningEffort, activity, conversation, connectError, pendingTool, pendingApprovals } = useAgentStore(
        useShallow((state) => ({
            engineId: state.engineId,
            runtimeId: state.runtimeId,
            engines: state.engines,
            switchingEngine: state.switchingEngine,
            engineBusy: agentIsBusy(state),
            width: state.width,
            url: state.url,
            token: state.token,
            connected: state.connected,
            enabled: state.enabled,
            prompt: state.prompt,
            attachments: state.attachments,
            sending: state.sending,
            waiting: state.waiting,
            tokenUsage: state.tokenUsage,
            eventLogs: state.eventLogs,
            threads: state.threads,
            activeThreadId: state.activeThreadId,
            workspacePath: state.workspacePath,
            loadingThreads: state.loadingThreads,
            activeTab: state.activeTab,
            confirmTools: state.confirmTools,
            permissionMode: state.permissionMode,
            models: state.models,
            model: state.model,
            reasoningEffort: state.reasoningEffort,
            activity: state.activity,
            conversation: state.conversation,
            connectError: state.connectError,
            pendingTool: state.pendingTool,
            pendingApprovals: state.pendingApprovals,
        })),
    );
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const conversationReady = conversation.status === "ready" || conversation.status === "warning";
    const conversationBusy = conversation.status === "preparing" || conversation.status === "running";
    const closePanel = useAgentStore((state) => state.closePanel);
    const pushMessage = useAgentStore((state) => state.addMessage);
    const pushEventLog = useAgentStore((state) => state.addEventLog);
    const clearEventLogs = useAgentStore((state) => state.clearEventLogs);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);
    const clearSkillSelection = useAgentSkillStore((state) => state.clearSelection);
    const skillCount = useAgentSkillStore((state) => state.skills.length);
    const messageCount = useAgentStore((state) => state.messages.length);
    const canvasContextRef = useRef<AgentCanvasContext | null>(useAgentStore.getState().canvasContext);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const autoConnectRef = useRef(false);
    const connectedRef = useRef(false);
    const errorLoggedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef("");
    const [clientReady, setClientReady] = useState(false);
    const loadThreadsSequenceRef = useRef(0);
    const loadThreadsRequestRef = useRef(0);
    const threadMessagesRef = useRef(new Map<string, AgentChatItem[]>());
    const authoritativeHistoryTurnsRef = useRef(new Set<string>());
    const liveTurnKeysRef = useRef(new Set<string>());
    const nativeSettingsThreadRef = useRef("");
    const settingsOpenedRef = useRef(false);
    const engineSwitchOperationRef = useRef<symbol | null>(null);
    const [catalogRevision, setCatalogRevision] = useState(0);
    const threadOperationRef = useRef(0);
    const threadOperationSequenceRef = useRef(0);
    const endpoint = useMemo(() => url.trim().replace(/\/$/, ""), [url]);
    const currentEngine = engines.find((item) => item.id === engineId);
    useLayoutEffect(() => {
        loadThreadsSequenceRef.current += 1;
        threadMessagesRef.current.clear();
        authoritativeHistoryTurnsRef.current.clear();
        liveTurnKeysRef.current.clear();
        nativeSettingsThreadRef.current = "";
        settingsOpenedRef.current = false;
        threadOperationRef.current = 0;
        pendingToolRef.current = null;
    }, [engineId, runtimeId]);
    const urlAgentAutoConnect = searchParams.has("agentUrl") && searchParams.has("agentToken");
    useEffect(() => {
        let disposed = false;
        void acquireAgentClientId().then((clientId) => {
            if (!disposed) {
                clientIdRef.current = clientId;
                setClientReady(true);
            }
        });
        return () => { disposed = true; };
    }, []);
    const loadThreadSnapshot = useCallback(async (threadId: string, sequence: number, response?: AgentThreadResponse, expectedTurnId = "") => {
        const scope = getAgentScope();
        let thread = response;
        let lastError: unknown;
        for (const delayMs of HISTORY_RETRY_DELAYS_MS) {
            if (delayMs) await delay(delayMs);
            if (!isCurrentAgentScope(scope) || sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().activeThreadId !== threadId) return false;
            try {
                thread ||= await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/${engineId}/threads/${encodeURIComponent(threadId)}`);
                lastError = undefined;
            } catch (error) {
                if (error instanceof StaleAgentResponseError) return;
                lastError = error;
                thread = undefined;
                continue;
            }
            const rawHistory = thread.messages || [];
            const history = normalizeHistoryMessages(scope.engineId === "dsh" ? rawHistory.map((item) => normalizeDshChatItem(item)) : rawHistory);
            const latest = useAgentStore.getState();
            if (!isCurrentAgentScope(scope) || sequence !== loadThreadsSequenceRef.current || latest.activeThreadId !== threadId) return false;
            const historyTurns = authoritativeHistoryTurnKeys(threadId, thread.settledTurnIds || []);
            const hasExpectedTurn = !expectedTurnId || historyTurns.has(`${threadId}\0${expectedTurnId}`);
            historyTurns.forEach((key) => liveTurnKeysRef.current.delete(key));
            if (latest.activeTurnId && !historyTurns.has(`${threadId}\0${latest.activeTurnId}`)) liveTurnKeysRef.current.add(`${threadId}\0${latest.activeTurnId}`);
            authoritativeHistoryTurnsRef.current = historyTurns;
            const messages = mergeAgentMessages(history, latest.messages, threadId, liveTurnKeysRef.current);
            threadMessagesRef.current.set(threadId, messages);
            setAgentState({ messages, connectError: "" });
            if (scope.engineId === "dsh" && thread.thread && nativeSettingsThreadRef.current !== threadId) {
                const selection = thread.thread.modelSelection;
                setAgentState({
                    ...(selection && !latest.modelChanged ? { model: JSON.stringify([selection.provider, selection.model]), reasoningEffort: selection.effort || "" } : {}),
                    ...(thread.thread.permissionMode && !latest.permissionChanged ? { permissionMode: thread.thread.permissionMode } : {}),
                });
                nativeSettingsThreadRef.current = threadId;
            }
            const coveredTurnIds = [...historyTurns].map((key) => key.slice(threadId.length + 1));
            if (coveredTurnIds.length) void acknowledgeAgentHistory(endpoint, token, threadId, coveredTurnIds).catch(() => undefined);
            if (hasExpectedTurn && (thread.historyReady !== false || Boolean(expectedTurnId))) return true;
            thread = undefined;
        }
        if (lastError) throw lastError;
        return false;
    }, [engineId, endpoint, setAgentState, token]);
    const applyWorkspaceChange = useCallback((data: AgentWorkspaceEvent) => {
        const nextThreadId = data.activeThreadId ?? data.threadId ?? "";
        const current = useAgentStore.getState();
        const threadChanged = current.activeThreadId !== nextThreadId;
        const emptyThread = Boolean(data.emptyThread || data.draftThread);
        const pendingMessage = [...current.messages].reverse().find((item) => item.role === "user" && !item.turnId);
        const keepPendingMessage = Boolean(
            data.emptyThread
            && pendingMessage
            && (current.sending || current.waiting)
            && (!data.sourceClientId || data.sourceClientId === clientIdRef.current),
        );
        if (threadChanged && current.activeThreadId) {
            const messages = keepPendingMessage ? current.messages.filter((item) => item.id !== pendingMessage!.id) : current.messages;
            threadMessagesRef.current.set(current.activeThreadId, messages);
        }
        if (emptyThread && nextThreadId) threadMessagesRef.current.delete(nextThreadId);
        if (threadChanged || emptyThread) {
            nativeSettingsThreadRef.current = "";
            loadThreadsSequenceRef.current += 1;
            authoritativeHistoryTurnsRef.current.clear();
            liveTurnKeysRef.current.clear();
        }
        const messages = keepPendingMessage
            ? [scopeChatItem(pendingMessage!, nextThreadId, "")]
            : emptyThread ? []
                : threadChanged ? threadMessagesRef.current.get(nextThreadId) || []
                    : current.messages;
        pendingToolRef.current = null;
        setAgentState({
            activeThreadId: nextThreadId,
            activeTurnId: threadChanged || emptyThread ? "" : current.activeTurnId,
            messages,
            tokenUsage: threadChanged || emptyThread ? null : current.tokenUsage,
            pendingTool: null,
            pendingApprovals: threadChanged || emptyThread ? [] : current.pendingApprovals,
        });
        return loadThreadsSequenceRef.current;
    }, [setAgentState]);
    const applyConversationState = useCallback((next: AgentConversationState, force = false) => {
        const current = useAgentStore.getState();
        if (!next?.revision || !force && next.revision <= current.conversation.revision) return false;
        const conversationChanged = next.conversationId !== current.conversation.conversationId;
        if (conversationChanged || next.threadId !== current.activeThreadId) {
            applyWorkspaceChange({
                activeThreadId: next.threadId,
                emptyThread: conversationChanged || !current.activeThreadId,
                draftThread: next.status === "preparing",
                sourceClientId: next.sourceClientId,
            });
        }
        setAgentState({ conversation: next, ...conversationBootstrapView(next) });
        return true;
    }, [applyWorkspaceChange, setAgentState]);
    const applyEngineResult = useCallback((data: AgentEngineActivation | AgentHelloEvent) => {
        const id = data.activeEngineId;
        const previous = useAgentStore.getState();
        const changed = previous.engineId !== id || previous.runtimeId !== data.runtimeId;
        const engine = data.engines?.find((item) => item.id === id) || ("engine" in data ? data.engine : undefined);
        const previousProfile = previous.engines.find((item) => item.id === "dsh")?.configProfile;
        const profileChanged = previous.engineId === "dsh" && id === "dsh" && previousProfile && engine?.configProfile && previousProfile !== engine.configProfile;
        useAgentStore.getState().applyEngine(id, data.runtimeId, data.engines);
        if (profileChanged) setAgentState({ models: [], model: "", reasoningEffort: "", permissionMode: "", modelChanged: false, permissionChanged: false });
        const current = useAgentStore.getState();
        const permissions = engine?.capabilities.permissions || [];
        setAgentState({
            globalBusy: Boolean(data.globalBusy),
            permissionMode: permissions.some((item) => item.id === current.permissionMode) ? current.permissionMode : engine?.capabilities.defaultPermissionMode || "",
            ...(data.workspace && "workspacePath" in data.workspace ? { workspacePath: data.workspace.workspacePath as string } : {}),
        });
        if (data.conversation) applyConversationState(data.conversation, changed);
    }, [applyConversationState, setAgentState]);
    const loadThreads = useCallback(async (skipHistory = false, expectedTurnId = "") => {
        if (!connectedRef.current && !useAgentStore.getState().connected) return;
        const scope = getAgentScope();
        const request = ++loadThreadsRequestRef.current;
        let sequence = ++loadThreadsSequenceRef.current;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, `/agent/${engineId}/threads`);
            if (sequence !== loadThreadsSequenceRef.current) return;
            if (data.conversation) {
                applyConversationState(data.conversation);
                sequence = loadThreadsSequenceRef.current;
            }
            const current = useAgentStore.getState();
            const currentThreadId = current.activeThreadId || data.workspace?.activeThreadId || "";
            if (!data.conversation && currentThreadId !== current.activeThreadId) sequence = applyWorkspaceChange({ activeThreadId: currentThreadId });
            if (sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().activeThreadId !== currentThreadId) return;
            setAgentState({ threads: data.data || [], workspacePath: data.workspace?.workspacePath || "" });
            if (currentThreadId && !skipHistory) {
                await loadThreadSnapshot(currentThreadId, sequence, undefined, expectedTurnId);
            } else {
                authoritativeHistoryTurnsRef.current.clear();
                liveTurnKeysRef.current.clear();
            }
        } catch (error) {
            if (error instanceof StaleAgentResponseError) return;
            addEventLog(rt("historyReadFailed"), error);
        } finally {
            // A workspace event may invalidate history without starting another request.
            if (request === loadThreadsRequestRef.current && isCurrentAgentScope(scope) && !threadOperationRef.current) setAgentState({ loadingThreads: false });
        }
    }, [applyConversationState, applyWorkspaceChange, engineId, endpoint, loadThreadSnapshot, setAgentState, token]);
    // Imperatively subscribe to canvasContext to keep the ref current and debounce snapshot reports without rerendering the panel.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useAgentStore.subscribe((state) => {
            if (state.canvasContext === canvasContextRef.current) return;
            canvasContextRef.current = state.canvasContext;
            if (!useAgentStore.getState().connected) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void postState(endpoint, token, clientIdRef.current, canvasContextRef.current?.snapshot || null), 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [endpoint, token]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);
    useEffect(() => {
        const cancelSwitch = () => {
            if (!engineSwitchOperationRef.current) return;
            engineSwitchOperationRef.current = null;
            setAgentState({ switchingEngine: false });
        };
        const unsubscribe = useAgentStore.subscribe((state, previous) => {
            if (previous.connected && !state.connected || previous.enabled && !state.enabled) cancelSwitch();
        });
        return () => { unsubscribe(); cancelSwitch(); };
    }, [setAgentState]);

    useEffect(() => {
        if (!clientReady || !enabled || !token.trim()) return;
        preferences.setItem("canvas-agent-url", endpoint);
        preferences.setItem("canvas-agent-token", token);
        const clientId = clientIdRef.current;
        let disposed = false;
        let protocolRejected = false;
        let eventQueue = Promise.resolve();
        const isCurrentConnection = () => !disposed && clientIdRef.current === clientId;
        const readScopedEvent = <T,>(event: Event): T | null => {
            const data = parseEventData<T & { engineId?: string; runtimeId?: string }>(event);
            return data && acceptsAgentEvent(data) ? data : null;
        };
        const enqueueEvent = (task: () => void | Promise<void>) => {
            const scope = getAgentScope();
            eventQueue = eventQueue.then(async () => {
                if (isCurrentConnection() && isCurrentAgentScope(scope)) await task();
            }).catch((error) => {
                if (isCurrentConnection()) addEventLog(rt("conversationSyncFailed"), error);
            });
        };
        const source = new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        source.addEventListener("hello", (event) => {
            if (!isCurrentConnection()) return;
            const hello = parseEventData<AgentHelloEvent>(event);
            if (hello?.protocolVersion !== AGENT_PROTOCOL_VERSION) {
                const text = rt("agentOutdated");
                protocolRejected = true;
                source.close();
                connectedRef.current = false;
                setAgentState({ enabled: false, connected: false, waiting: false, sending: false, activity: rt("restartRequired"), connectError: text, silentConnect: false, fragmentBootstrap: false, pendingTool: null, pendingApprovals: [] });
                useAgentSkillStore.getState().reset();
                addEventLog(rt("versionMismatch"), text, hello);
                if (!headless) message.error(text);
                return;
            }
            applyEngineResult(hello);
            const codex = hello.agent || hello.codex;
            const busy = Boolean(codex?.busy);
            const nextThreadId = hello?.conversation?.threadId ?? hello?.workspace?.activeThreadId ?? useAgentStore.getState().activeThreadId;
            if (hello?.conversation) applyConversationState(hello.conversation, true);
            else applyWorkspaceChange({ activeThreadId: nextThreadId });
            const current = useAgentStore.getState();
            const nextTurnId = codex?.threadId === nextThreadId ? codex.turnId ?? "" : "";
            if (nextTurnId) liveTurnKeysRef.current.add(`${nextThreadId}\0${nextTurnId}`);
            const activeTurnId = busy ? nextTurnId : "";
            const pendingApprovals = (hello?.pendingApprovals || []).filter((item) => !item.threadId || item.threadId === nextThreadId).map((item) => ({ ...item, engineId: hello.activeEngineId, runtimeId: hello.runtimeId }));
            const messages = activeTurnId
                ? bindPendingTurnMessages(current.messages.filter((item) => !isConnectionErrorMessage(item)), nextThreadId, activeTurnId)
                : current.messages.filter((item) => !isConnectionErrorMessage(item));
            errorLoggedRef.current = false;
            connectedRef.current = true;
            setAgentState({
                connected: true,
                activity: pendingApprovals.length ? rt("awaitingApproval") : busy ? rt("codexRunning") : rt("connected"),
                waiting: busy,
                sending: false,
                connectError: "",
                silentConnect: false,
                fragmentBootstrap: false,
                activeThreadId: nextThreadId,
                activeTurnId,
                messages,
                pendingApprovals,
            });
            if (!headless) message.success(rt("localAgentConnected"));
            void postState(endpoint, token, clientId, canvasContextRef.current?.snapshot || null);
            if (document.visibilityState === "visible" && document.hasFocus()) void activateAgentClient(endpoint, token, clientId);
            if (hello.activeEngineId === engineId && !busy && !nextThreadId && (!hello?.conversation || hello.conversation.status === "idle")) {
                void fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, `/agent/${engineId}/threads/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, ...(permissionMode ? { permissionMode } : {}) }) })
                    .then((result) => result.conversation && applyConversationState(result.conversation))
                    .catch((error) => {
                        if (error instanceof StaleAgentResponseError) return;
                        const state = agentErrorState(error);
                        if (state) applyConversationState(state);
                        addEventLog(rt("conversationInitFailed"), error);
                    });
            }
        });
        source.addEventListener("engine_changed", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentEngineActivation>(event);
            if (!data || !data.runtimeId || !data.activeEngineId) return;
            applyEngineResult(data);
        });
        const onAgentState = (event: Event) => {
            const data = readScopedEvent<AgentCodexState>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const busy = Boolean(data.busy);
                const current = useAgentStore.getState();
                setAgentState({ globalBusy: Boolean(data.globalBusy ?? data.busy) });
                const appliesToCurrentThread = !data.threadId || data.threadId === current.activeThreadId;
                if (!appliesToCurrentThread) return;
                const turnId = data.turnId || current.activeTurnId;
                if (turnId) liveTurnKeysRef.current.add(`${current.activeThreadId}\0${turnId}`);
                const activeTurnId = busy ? turnId : "";
                const messages = activeTurnId ? bindPendingTurnMessages(current.messages, current.activeThreadId, activeTurnId) : current.messages;
                setAgentState({
                    globalBusy: Boolean(data.globalBusy ?? data.busy),
                    stopping: busy ? current.stopping : false,
                    activity: busy ? rt("codexRunning") : current.activity === rt("processingFailed") ? rt("processingFailed") : rt("completed"),
                    waiting: busy,
                    sending: false,
                    activeTurnId,
                    messages,
                });
                if (!busy && current.waiting) void loadThreads(false, turnId);
            });
        };
        source.addEventListener("codex_state", onAgentState);
        source.addEventListener("agent_state", onAgentState);
        source.addEventListener("tool_call", (event) => {
            if (!isCurrentConnection()) return;
            const data = readScopedEvent<AgentPendingToolCall>(event);
            if (data) void handleToolCall(endpoint, token, data);
        });
        source.addEventListener("tool_cancelled", (event) => {
            if (!isCurrentConnection()) return;
            const data = readScopedEvent<AgentToolIdentity>(event);
            if (!data) return;
            pendingToolRef.current = cancelPendingAgentTool(pendingToolRef.current, data);
            const current = useAgentStore.getState().pendingTool;
            const pendingTool = cancelPendingAgentTool(current, data);
            if (pendingTool !== current) setAgentState({ pendingTool });
        });
        const onApproval = (event: Event) => {
            if (!isCurrentConnection()) return;
            const data = readScopedEvent<AgentPendingApproval>(event);
            if (!data || !isCurrentThreadEvent(data)) return;
            setAgentState({ pendingApprovals: [...useAgentStore.getState().pendingApprovals.filter((item) => item.requestId !== data.requestId), data], activity: rt("awaitingApproval") });
            addEventLog(rt("awaitingApproval"), data.reason || data.method, data);
        };
        source.addEventListener("codex_approval", onApproval);
        source.addEventListener("agent_approval", onApproval);
        source.addEventListener("dsh_approval", onApproval);
        const onApprovalResolved = (event: Event) => {
            if (!isCurrentConnection()) return;
            const data = readScopedEvent<{ requestId?: string; decision?: string }>(event);
            if (!data?.requestId) return;
            const current = useAgentStore.getState();
            const approval = current.pendingApprovals.find((item) => item.requestId === data.requestId);
            const pendingApprovals = current.pendingApprovals.filter((item) => item.requestId !== data.requestId);
            setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, current.waiting, current.activity) });
            const decision = data.decision || approval?.deciding;
            if (approval && decision) addEventLog(rt(["accept", "acceptForSession", "allowed-once"].includes(decision) ? "approvalGranted" : "approvalCanceled"), approval.reason || approval.method, approval);
        };
        source.addEventListener("codex_approval_resolved", onApprovalResolved);
        source.addEventListener("agent_approval_resolved", onApprovalResolved);
        source.addEventListener("dsh_approval_resolved", onApprovalResolved);
        source.addEventListener("agent_event", (event) => {
            const data = readScopedEvent<AgentEventPayload>(event);
            if (data) enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                const shouldProcess = registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current);
                if (data.type !== "usage.updated" && !shouldProcess) return;
                return handleAgentEvent(data);
            });
        });
        source.addEventListener("dsh_event", (event) => {
            const data = readScopedEvent<DshEvent>(event);
            if (!data || data.engineId !== "dsh") return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (data.type === "history.snapshot") {
                    const removed = new Set(data.removeItemIds || []);
                    if (removed.size) setAgentState({ messages: useAgentStore.getState().messages.filter((item) => item.threadId !== data.threadId || !removed.has(item.itemId || "")) });
                    return loadThreadSnapshot(data.threadId, ++loadThreadsSequenceRef.current, { messages: data.messages || [], settledTurnIds: data.settledTurnIds || [], historyReady: true }).then(() => undefined);
                }
                if (data.type === "usage.updated" && data.usage) { setAgentState({ tokenUsage: data.usage }); return; }
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                const current = useAgentStore.getState();
                if (data.item || data.removeItemId) {
                    setAgentState({ messages: mergeDshEventMessage(current.messages, data) });
                }
                if (data.type === "turn.started") setAgentState({ waiting: true, sending: false, activeTurnId: data.turnId, messages: bindPendingTurnMessages(current.messages, data.threadId, data.turnId), activity: t("agentEngines.running", { engine: "DSH" }) });
                if (data.type === "turn.completed" || data.type === "turn.failed") {
                    setAgentState({ waiting: false, sending: false, stopping: false, activeTurnId: "", activity: data.status === "interrupted" ? rt("taskStopped") : rt(data.type === "turn.failed" ? "processingFailed" : "completed") });
                    void loadThreads(false, data.turnId);
                }
                if (data.type === "turn.failed" && data.error) addMessage({ role: "error", threadId: data.threadId, turnId: data.turnId, text: typeof data.error === "string" ? data.error : data.error.message || rt("processingFailed") });
            });
        });
        source.addEventListener("agent_bootstrap", (event) => {
            const data = readScopedEvent<AgentBootstrapEvent>(event);
            if (!data?.type) return;
            if (data.type === "codex.preparing") {
                addEventLog(rt("conversationInitializing"), rt("conversationCreating"), data);
                return;
            }
            if (data.type === "codex.prepare_failed") {
                addEventLog(rt("conversationInitFailed"), data.error, data);
                return;
            }
            if (data.type === "mcp.complete") {
                addEventLog(rt("mcpStatusComplete"), rt("mcpListRead"), data);
                return;
            }
            if (!data.name || !data.status) return;
            const label = data.name;
            const status = data.status === "starting"
                ? { text: rt("mcpStarting", { name: label }), detail: rt("mcpConnecting"), status: "running" as const }
                : data.status === "ready"
                    ? { text: rt("mcpReadyNamed", { name: label }), detail: rt("toolsReady"), status: "ready" as const }
                    : data.status === "failed"
                        ? { text: rt("mcpFailedNamed", { name: label }), detail: data.error || rt("toolInitFailed"), status: "error" as const }
                        : { text: rt("mcpCanceledNamed", { name: label }), detail: rt("toolInitCanceled"), status: "error" as const };
            addEventLog(status.text, status.detail, data);
        });
        source.addEventListener("conversation_changed", (event) => {
            const data = readScopedEvent<AgentConversationState>(event);
            if (data) enqueueEvent(() => { applyConversationState(data); });
        });
        source.addEventListener("workspace_changed", (event) => {
            const data = readScopedEvent<AgentWorkspaceEvent>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (data.conversation) applyConversationState(data.conversation);
                else applyWorkspaceChange(data);
                if (!data.draftThread) void loadThreads(Boolean(data.emptyThread));
            });
        });
        source.addEventListener("chat_message", (event) => {
            const data = readScopedEvent<AgentChatEvent>(event);
            if (!data?.message) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                const current = useAgentStore.getState();
                const threadId = data.threadId || data.message!.threadId || current.activeThreadId;
                const turnId = data.turnId ?? data.message!.turnId ?? "";
                const clientMessageId = data.message!.clientMessageId || data.message!.itemId || data.message!.id;
                if (current.activeThreadId !== threadId) return;
                const next = scopeChatItem(data.message!, threadId, turnId);
                const currentMessages = data.message!.role === "user" && clientMessageId
                    ? current.messages.filter((item) => item.role !== "user" || item.clientMessageId !== clientMessageId || item.id === next.id)
                    : current.messages;
                const messages = upsertAgentMessage(currentMessages, next);
                setAgentState({ messages });
            });
        });
        source.addEventListener("agent_log", (event) => {
            if (!isCurrentConnection()) return;
            const data = readScopedEvent<{ text?: unknown }>(event);
            if (!data) return;
            const text = data.text;
            addEventLog(rt("log"), text, text);
        });
        source.addEventListener("skills_changed", (event) => {
            if (!isCurrentConnection()) return;
            const data = readScopedEvent<{ forceReload?: boolean }>(event);
            if (!data) return;
            void loadSkills(endpoint, token, Boolean(data?.forceReload));
        });
        source.addEventListener("agent_error", (event) => {
            const data = readScopedEvent<AgentEventPayload>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                showAgentError(data.message, data, !data.replayed);
            });
        });
        source.onerror = () => {
            if (disposed || protocolRejected) return;
            invalidateAgentScope();
            const wasConnected = connectedRef.current;
            const silent = useAgentStore.getState().silentConnect && !wasConnected;
            const text = rt(wasConnected ? "connectionLostDescription" : "connectionFailedDescription");
            if (!errorLoggedRef.current || wasConnected) {
                addEventLog(rt(wasConnected ? "connectionLost" : "connectionFailed"), text);
                if (!headless && !silent) message.error(text);
            }
            errorLoggedRef.current = true;
            connectedRef.current = false;
            pendingToolRef.current = null;
            setAgentState({
                activity: rt(wasConnected ? "connectionLost" : "connectionFailed"),
                connected: false,
                waiting: false,
                sending: false,
                connectError: silent ? "" : text,
                silentConnect: false,
                fragmentBootstrap: false,
                pendingTool: null,
                pendingApprovals: [],
            });
            useAgentSkillStore.getState().reset();
            if (!wasConnected) {
                source.close();
                setAgentState({ enabled: false });
            }
        };
        return () => {
            disposed = true;
            invalidateAgentScope();
            source.close();
            connectedRef.current = false;
            nativeSettingsThreadRef.current = "";
            loadThreadsSequenceRef.current += 1;
            useAgentSkillStore.getState().reset();
        };
    }, [applyConversationState, applyEngineResult, applyWorkspaceChange, clientReady, enabled, engineId, runtimeId, endpoint, loadSkills, loadThreads, message, setAgentState, token]);

    useEffect(() => {
        if (connected) void loadThreads();
    }, [connected, loadThreads, runtimeId]);

    useEffect(() => {
        if (connected) void loadSkills(endpoint, token);
    }, [connected, engineId, runtimeId, catalogRevision, endpoint, loadSkills, token]);

    useEffect(() => {
        if (!connected) return;
        const scope = getAgentScope();
        void fetchAgentEngines(endpoint, token).then((catalog) => {
            if (isCurrentAgentScope(scope) && catalog.activeEngineId === scope.engineId && catalog.runtimeId === scope.runtimeId) setAgentState({ engines: catalog.engines });
        }).catch((error) => { if (isCurrentAgentScope(scope)) addEventLog(t("agentEngines.catalogFailed"), error); });
    }, [connected, engineId, runtimeId, catalogRevision, endpoint, setAgentState, token]);

    useEffect(() => {
        if (!connected) return;
        void fetchAgentJson<AgentModelsResponse>(endpoint, token, `/agent/${engineId}/models`).then(({ data = [] }) => {
            const models = data.flatMap((item) => {
                const efforts = item.supportedReasoningEfforts || [];
                if (engineId === "codex" && item.model === "codex-auto-review") return [];
                const defaultReasoningEffort = efforts.some((effort) => effort.reasoningEffort === item.defaultReasoningEffort) ? item.defaultReasoningEffort : efforts[0]?.reasoningEffort || "";
                return [{ ...item, supportedReasoningEfforts: efforts, defaultReasoningEffort }];
            });
            if (!models.length) return;
            const savedModel = useAgentStore.getState().model;
            const current = models.find((item) => (item.id || item.model) === savedModel) || models.find((item) => item.isDefault) || models[0];
            const savedEffort = useAgentStore.getState().reasoningEffort;
            const efforts = current.supportedReasoningEfforts.map((item) => item.reasoningEffort);
            const nextEffort = efforts.includes(savedEffort) ? savedEffort : current.defaultReasoningEffort || efforts[0] || "";
            const model = current.id || current.model;
            preferences.setItem(enginePreferenceKey(engineId, "model"), model);
            preferences.setItem(enginePreferenceKey(engineId, "effort"), nextEffort);
            setAgentState({ models, model, reasoningEffort: nextEffort });
        }).catch((error) => { if (!(error instanceof StaleAgentResponseError)) addEventLog(rt("modelListFailed"), error); });
    }, [connected, engineId, runtimeId, catalogRevision, endpoint, setAgentState, token]);

    useEffect(() => {
        if (!connected) return;
        const activate = () => {
            void activateAgentClient(endpoint, token, clientIdRef.current);
            if (engineId === "dsh" && !agentIsBusy(useAgentStore.getState())) {
                nativeSettingsThreadRef.current = "";
                void loadThreads();
                if (settingsOpenedRef.current) { settingsOpenedRef.current = false; setCatalogRevision((revision) => revision + 1); }
            }
        };
        const activateVisible = () => {
            if (document.visibilityState === "visible") activate();
        };
        window.addEventListener("focus", activate);
        document.addEventListener("visibilitychange", activateVisible);
        return () => {
            window.removeEventListener("focus", activate);
            document.removeEventListener("visibilitychange", activateVisible);
        };
    }, [connected, engineId, endpoint, loadThreads, token]);
    const sendPrompt = async () => {
        const scope = getAgentScope();
        const text = prompt.trim();
        const files = attachments;
        const skillState = useAgentSkillStore.getState();
        const selectedSkill = skillState.selectedSkill;
        const selectedSkillRevision = skillState.selectionRevision;
        const currentState = useAgentStore.getState();
        if (currentState.switchingEngine || currentState.globalBusy || currentState.draftingSkill || currentState.stopping) return;
        const canvasNodeIds = new Set(currentState.canvasContext?.snapshot.nodes.map((node) => node.id) || []);
        const canvasReferences = currentState.canvasReferences.filter((item) => canvasNodeIds.has(item.nodeId));
        if (canvasReferences.length !== currentState.canvasReferences.length) {
            setAgentState({ canvasReferences });
            message.warning(rt(canvasReferences.length ? "someCanvasReferencesMissing" : "canvasReferencesMissing"));
        }
        const requestPrompt = promptWithCanvasReferences(promptWithAttachments(text, files), canvasReferences);
        if (!currentState.connected || !requestPrompt || currentState.sending || currentState.waiting || currentState.loadingThreads || !["ready", "warning"].includes(currentState.conversation.status)) return;
        let referenceImages: AgentAttachment[] = [];
        if (canvasReferences.some((item) => item.kind === "image")) {
            setAgentState({ sending: true, activity: rt("readingCanvasImages") });
            try {
                referenceImages = await resolveCanvasReferenceImages(canvasReferences, currentState.canvasContext?.snapshot.nodes || []);
                if (!isCurrentAgentScope(scope)) return;
            } catch (error) {
                if (!isCurrentAgentScope(scope) || error instanceof StaleAgentResponseError) return;
                setAgentState({ sending: false, activity: rt("canvasImageReadFailed") });
                addMessage({ role: "error", title: rt("canvasImageReadFailed"), text: error instanceof Error ? error.message : rt("canvasImageReadFailed") });
                return;
            }
        }
        const requestFiles = [...files, ...referenceImages.filter((reference) => !files.some((file) => file.dataUrl === reference.dataUrl))];
        if (requestFiles.length > MAX_ATTACHMENTS) {
            setAgentState({ sending: false, activity: rt("tooManyImages") });
            addMessage({ role: "error", title: rt("tooManyImages"), text: rt("imageCountLimit", { count: MAX_ATTACHMENTS }) });
            return;
        }
        if (attachmentPayloadBytes(requestFiles) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            setAgentState({ sending: false, activity: rt("imageTooLarge") });
            addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imagePayloadTooLarge") });
            return;
        }
        const messageId = createId();
        const userText = text || rt(files.length ? "imagesSent" : "canvasReferencesSent", { count: files.length || canvasReferences.length });
        const messageReferences: AgentCanvasReference[] = await Promise.all(canvasReferences.map(async ({ nodeId, label, title, kind, previewUrl, text }) => {
            const image = referenceImages.find((item) => item.id === `canvas:${nodeId}`);
            return { nodeId, label, title, kind, previewUrl: image ? (await createMessageAttachmentMetadata(image)).url : previewUrl, text };
        }));
        const messageSkill = selectedSkill ? { engineId, name: selectedSkill.name, path: selectedSkill.path, displayName: selectedSkill.interface?.displayName || undefined } : undefined;
        if (!isCurrentAgentScope(scope)) return;
        loadThreadsSequenceRef.current += 1;
        const currentBeforeSend = useAgentStore.getState();
        const requestThreadId = currentBeforeSend.activeThreadId;
        setAgentState({ prompt: "", attachments: [], canvasReferences: [], activity: rt("sending"), sending: true, loadingThreads: false, activeTurnId: "", messages: currentBeforeSend.messages });
        addMessage({ id: messageId, itemId: "synthetic:user", clientMessageId: messageId, threadId: requestThreadId, turnId: "", role: "user", text: userText, attachments: files, canvasReferences: messageReferences, skill: messageSkill });
        let threadId = requestThreadId;
        try {
            const messageAttachments = await Promise.all(files.map(createMessageAttachmentMetadata));
            if (!isCurrentAgentScope(scope)) return;
            const messageMetadata = {
                ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
                ...(messageReferences.length ? { canvasReferences: messageReferences } : {}),
                ...(messageSkill ? { skill: messageSkill } : {}),
            };
            const selectedModel = models.find((item) => (item.id || item.model) === model);
            const modelName = selectedModel?.displayName || model || rt("defaultModel");
            const effortName = reasoningEffort ? i18n.t(`agent.composer.effort.${reasoningEffort}`, { defaultValue: reasoningEffort }) : rt("defaultEffort");
            addEventLog(rt("sendTask"), `${modelName} · ${effortName}${selectedSkill ? ` · Skill ${selectedSkill.name}` : ""}${files.length ? ` · ${rt("attachmentCount", { count: files.length })}` : ""}${canvasReferences.length ? ` · ${rt("canvasReferenceCount", { count: canvasReferences.length })}` : ""} · ${compactText(text) || rt(canvasReferences.length ? "canvasReferencesOnly" : "attachmentsOnly")}`);
            const accepted = await fetchAgentJson<AgentTurnResponse>(endpoint, token, `/agent/${engineId}/turn`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    prompt: requestPrompt,
                    messageText: userText,
                    messageId,
                    clientId: clientIdRef.current,
                    threadId,
                    conversationId: currentBeforeSend.conversation.conversationId,
                    expectedRevision: currentBeforeSend.conversation.revision,
                    ...agentTurnSettings(currentBeforeSend),
                    skill: selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path } : undefined,
                    attachments: requestFiles.map(({ id, name, type, size, width, height, dataUrl }) => ({ id, name, type, size, width, height, dataUrl })),
                    messageMetadata,
                }),
            });
            threadId = accepted.threadId || threadId;
            if (!threadId) throw new Error(rt("startConversationFailed"));
            setAgentState({ modelChanged: false, permissionChanged: false });
            if (selectedSkill) clearSkillSelection(selectedSkillRevision);
            files.forEach((item) => {
                URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
        } catch (error) {
            if (error instanceof StaleAgentResponseError) return;
            const text = error instanceof Error ? error.message : rt("sendFailed");
            const response = error instanceof AgentApiError ? error.response as { code?: string; state?: AgentConversationState } : undefined;
            if (response?.state) applyConversationState(response.state);
            const stale = response?.code === "CONVERSATION_STALE";
            const busy = response?.code === "CONVERSATION_BUSY" || text.includes("Codex 正在运行");
            const state = useAgentStore.getState();
            const removeFailedPending = (messages: AgentChatItem[]) => messages.filter((item) => item.clientMessageId !== messageId || Boolean(item.turnId));
            threadMessagesRef.current.forEach((messages, cachedThreadId) => {
                const next = removeFailedPending(messages);
                if (next.length !== messages.length) threadMessagesRef.current.set(cachedThreadId, next);
            });
            const ownsCurrentThread = state.activeThreadId === (threadId || requestThreadId);
            const restoreDraft = state.prompt || state.attachments.length || state.canvasReferences.length ? {} : { prompt, attachments: files, canvasReferences };
            if (ownsCurrentThread) {
                setAgentState({
                    activity: rt(stale ? "conversationSynced" : busy ? "codexRunning" : "sendFailed"),
                    sending: false,
                    messages: removeFailedPending(state.messages),
                    ...restoreDraft,
                });
                addMessage({ threadId: state.activeThreadId, turnId: "", role: "error", title: rt(stale ? "conversationSynced" : busy ? "taskStillRunning" : "sendFailed"), text });
            } else {
                setAgentState({ sending: false, messages: removeFailedPending(state.messages), ...restoreDraft });
            }
            addEventLog(rt("sendFailed"), error);
        }
    };

    const stopTurn = async () => {
        if (!connected || (!sending && !waiting)) return;
        const scope = getAgentScope();
        setAgentState({ stopping: true, activity: rt("stopping") });
        try {
            await interruptAgentTurn(endpoint, token, useAgentStore.getState().activeThreadId || undefined);
            addEventLog(rt("stopTask"), rt("taskStopped"));
        } catch (error) {
            if (error instanceof StaleAgentResponseError) return;
            setAgentState({ activity: rt("stopFailed") });
            addEventLog(rt("stopFailed"), error);
        } finally {
            if (isCurrentAgentScope(scope)) setAgentState({ stopping: false });
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const scope = getAgentScope();
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useAgentStore.getState().attachments;
        try {
            const next = await Promise.all(
                images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                    const dataUrl = await readDataUrl(file);
                    const meta = await readImageMeta(dataUrl);
                    const url = URL.createObjectURL(file);
                    attachmentUrlsRef.current.add(url);
                    return { id: createId(), name: file.name, type: file.type, size: file.size, width: meta.width, height: meta.height, url, dataUrl };
                }),
            );
            if (!isCurrentAgentScope(scope)) {
                next.forEach((item) => { URL.revokeObjectURL(item.url); attachmentUrlsRef.current.delete(item.url); });
                return;
            }
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imageLimit") });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            if (!isCurrentAgentScope(scope) || error instanceof StaleAgentResponseError) return;
            addMessage({ role: "error", title: rt("imageReadFailed"), text: error instanceof Error ? error.message : rt("imageReadFailed") });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (confirmToolsRef.current && isCanvasWriteTool(payload.name)) {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: rt("pendingCanvasTool") });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload });
            addEventLog(rt("awaitingConfirmation"), payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        const scope = getAgentScope();
        const sendResult = (body: { requestId: string; result?: unknown; error?: string }) => postToolResult(endpoint, token, clientIdRef.current, body, scope);
        if (isSiteTool(payload.name)) {
            try {
                addEventLog(toolName(payload.name), payload, payload);
                const result = await runSiteTool(payload.name, payload.input || {}, navigate, { canvasSnapshot: canvasContextRef.current?.snapshot || null });
                await sendResult({ requestId: payload.requestId, result });
                addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
            } catch (error) {
                if (error instanceof StaleAgentResponseError) return;
                const message = error instanceof Error ? error.message : rt("toolExecutionFailed");
                await sendResult({ requestId: payload.requestId, error: message });
            }
            return;
        }
        try {
            const input: { ops?: CanvasAgentOp[]; path?: string } = payload.input || {};
            addEventLog(toolName(payload.name), payload, payload);
            let result: unknown;
            let appliedOps = input.ops || [];
            if (payload.name === "site_navigate") {
                const path = input.path || "/";
                navigate(path);
                result = { ok: true, path };
            } else if (payload.name === "canvas_apply_ops") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                result = context.applyOps(appliedOps);
                void postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else if (payload.name === "canvas_create_attachment_nodes") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                appliedOps = await attachmentNodeOps(endpoint, token, clientIdRef.current, payload.input?.nodes);
                if (!isCurrentAgentScope(scope)) return;
                result = context.applyOps(appliedOps);
                await postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else {
                const snapshot = canvasContextRef.current?.snapshot;
                if (!snapshot) throw new Error(rt("openCanvasFirst"));
                result = snapshot;
            }
            await sendResult({ requestId: payload.requestId, result });
            addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
        } catch (error) {
            if (error instanceof StaleAgentResponseError) return;
            const message = error instanceof Error ? error.message : rt("canvasOperationFailed");
            await sendResult({ requestId: payload.requestId, error: message });
        }
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: rt("canvasToolCanceled") });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    const decideApproval = async (approval: AgentPendingApproval, decision: string) => {
        if (!acceptsAgentEvent(approval)) return;
        const current = useAgentStore.getState();
        const pending = current.pendingApprovals.find((item) => item.requestId === approval.requestId);
        if (!pending || pending.deciding || pending.decisions && !pending.decisions.some((item) => item.value === decision)) return;
        setAgentState({ pendingApprovals: current.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: decision } : item), activity: rt("submittingApproval") });
        try {
            await postAgentApproval(endpoint, token, approval.requestId, decision);
            const latest = useAgentStore.getState();
            if (latest.pendingApprovals.some((item) => item.requestId === approval.requestId)) setAgentState({ activity: rt("waitingCodexApproval") });
        } catch (error) {
            if (error instanceof StaleAgentResponseError) return;
            const latest = useAgentStore.getState();
            const expired = error instanceof Error && error.message.includes("审批请求已失效");
            const resolved = expired || !latest.pendingApprovals.some((item) => item.requestId === approval.requestId);
            const pendingApprovals = resolved
                ? latest.pendingApprovals.filter((item) => item.requestId !== approval.requestId)
                : latest.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: undefined } : item);
            setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, latest.waiting, latest.activity) });
            if (resolved) return;
            addEventLog(rt("approvalFailed"), error);
            message.error(error instanceof Error ? error.message : rt("approvalFailed"));
        }
    };

    const changePermissionMode = (nextMode: AgentPermissionMode) => {
        const scope = getAgentScope();
        const apply = () => {
            if (!isCurrentAgentScope(scope)) return;
            preferences.setItem(enginePreferenceKey(engineId, "permission"), nextMode);
            setAgentState({ permissionMode: nextMode, permissionChanged: true });
        };
        if (engineId !== "codex" || nextMode !== "full") return apply();
        modal.confirm({
            title: rt("enableFullAccess"),
            content: rt("fullAccessDescription"),
            okText: rt("enableFullAccessAction"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: apply,
        });
    };

    const switchEngine = async (nextEngineId: AgentEngineId) => {
        const current = useAgentStore.getState();
        if (!current.connected || nextEngineId === current.engineId || agentIsBusy(current)) return;
        const scope = getAgentScope();
        const operation = Symbol();
        engineSwitchOperationRef.current = operation;
        setAgentState({ switchingEngine: true });
        try {
            const result = await activateAgentEngine(endpoint, token, nextEngineId, clientIdRef.current);
            if (engineSwitchOperationRef.current !== operation || !isCurrentAgentScope(scope)) return;
            applyEngineResult(result);
        } catch (error) {
            if (engineSwitchOperationRef.current === operation && isCurrentAgentScope(scope)) message.error(error instanceof Error ? error.message : t("agentEngines.switchFailed"));
        } finally {
            if (engineSwitchOperationRef.current === operation) {
                engineSwitchOperationRef.current = null;
                setAgentState({ switchingEngine: false });
            }
        }
    };

    const manageSettings = async () => {
        if (agentIsBusy(useAgentStore.getState())) return;
        try { await openAgentSettings(endpoint, token); settingsOpenedRef.current = true; }
        catch (error) { if (!(error instanceof StaleAgentResponseError)) message.error(error instanceof Error ? error.message : t("agentEngines.settingsFailed")); }
    };

    const switchConfigProfile = async (profile: DshConfigProfile) => {
        const current = useAgentStore.getState();
        if (!current.connected || current.engineId !== "dsh" || current.engines.find((engine) => engine.id === "dsh")?.configProfile === profile || agentIsBusy(current)) return;
        const scope = getAgentScope();
        const operation = Symbol();
        engineSwitchOperationRef.current = operation;
        setAgentState({ switchingEngine: true });
        try {
            const result = await switchDshConfigProfile(endpoint, token, profile, clientIdRef.current);
            if (engineSwitchOperationRef.current === operation && isCurrentAgentScope(scope)) applyEngineResult(result);
        } catch (error) {
            if (engineSwitchOperationRef.current !== operation) return;
            const latest = useAgentStore.getState();
            const failureScope = error instanceof AgentApiError ? error.response as { engineId?: string; runtimeId?: string } : null;
            const currentTargetFailed = latest.connected && latest.engineId === "dsh" && latest.engines.find((engine) => engine.id === "dsh")?.configProfile === profile && failureScope && acceptsAgentEvent(failureScope);
            if (isCurrentAgentScope(scope) || currentTargetFailed) message.error(error instanceof Error ? error.message : t("agentEngines.configProfileFailed"));
        } finally {
            if (engineSwitchOperationRef.current === operation) {
                engineSwitchOperationRef.current = null;
                setAgentState({ switchingEngine: false });
            }
        }
    };

    const toggleAgentConnection = async ({ silent = false }: { silent?: boolean } = {}) => {
        if (enabled) {
            clearAgentSession({ enabled: false, connected: false, activity: rt("offline"), connectError: "" });
            return;
        }
        const urlToken = searchParams.get("agentToken") || "";
        const urlEndpoint = searchParams.get("agentUrl") || "";
        const discovered = urlToken ? null : await discoverAgentConfig(endpoint || DEFAULT_AGENT_URL);
        const nextEndpoint = (urlEndpoint || discovered?.url || endpoint || DEFAULT_AGENT_URL).trim().replace(/\/$/, "");
        const nextToken = (urlToken || token.trim() || discovered?.token || "").trim();
        if (!nextEndpoint) {
            const text = rt("addressRequired");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        if (!nextToken) {
            const text = rt("agentNotFound");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        try {
            const parsed = new URL(nextEndpoint);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
        } catch {
            const text = rt("invalidAddress");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: nextEndpoint, token: nextToken, enabled: true, connected: false, silentConnect: silent, fragmentBootstrap: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
    };

    useLayoutEffect(() => {
        const bootstrap = readAgentUrlBootstrap(hash);
        if (!bootstrap) return;
        navigate(`${window.location.pathname}${window.location.search}${bootstrap.remainingHash}`, { replace: true });
        if (!bootstrap.url || !bootstrap.token) {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt(!bootstrap.url ? "addressRequired" : "agentNotFound") });
            useAgentStore.getState().openPanel();
            return;
        }
        try {
            const parsed = new URL(bootstrap.url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
        } catch {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt("invalidAddress") });
            useAgentStore.getState().openPanel();
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: bootstrap.url.replace(/\/$/, ""), token: bootstrap.token, enabled: true, connected: false, silentConnect: true, fragmentBootstrap: true, confirmTools: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
    }, [hash, navigate, setAgentState]);

    useEffect(() => {
        if (urlAgentAutoConnect && confirmTools) setAgentState({ confirmTools: false });
    }, [confirmTools, setAgentState, urlAgentAutoConnect]);

    useEffect(() => {
        if ((!autoConnect && !urlAgentAutoConnect) || autoConnectRef.current || enabled || connected) return;
        autoConnectRef.current = true;
        void toggleAgentConnection({ silent: true });
    }, [autoConnect, connected, enabled, urlAgentAutoConnect]);

    function clearAgentSession(patch: Parameters<typeof setAgentState>[0] = {}) {
        invalidateAgentScope();
        loadThreadsSequenceRef.current += 1;
        threadMessagesRef.current.clear();
        authoritativeHistoryTurnsRef.current.clear();
        liveTurnKeysRef.current.clear();
        threadOperationRef.current = 0;
        setAgentState({
            messages: [],
            tokenUsage: null,
            threads: [],
            activeThreadId: "",
            activeTurnId: "",
            workspacePath: "",
            loadingThreads: false,
            waiting: false,
            sending: false,
            stopping: false,
            draftingSkill: false,
            switchingEngine: false,
            fragmentBootstrap: false,
            pendingTool: null,
            pendingApprovals: [],
            conversation: { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} },
            bootstrapStatus: null,
            mcpStartupStatuses: {},
            ...patch,
        });
        useAgentSkillStore.getState().reset();
        pendingToolRef.current = null;
    }

    const beginThreadOperation = () => {
        const operation = ++threadOperationSequenceRef.current;
        threadOperationRef.current = operation;
        setAgentState({ loadingThreads: true });
        return operation;
    };

    const finishThreadOperation = (operation: number) => {
        if (threadOperationRef.current !== operation) return;
        threadOperationRef.current = 0;
        setAgentState({ loadingThreads: false });
    };

    const startNewThread = async () => {
        const current = useAgentStore.getState();
        if (!current.connected || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        clearSkillSelection();
        setAgentState({ activeTab: "chat", activity: rt("creatingConversation") });
        try {
            const result = await fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, `/agent/${engineId}/threads/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current, ...(permissionMode ? { permissionMode } : {}) }) });
            if (threadOperationRef.current !== operation) return;
            if (result.conversation) applyConversationState(result.conversation);
            setAgentState({ activeTab: "chat", activity: rt("newConversation") });
        } catch (error) {
            if (error instanceof StaleAgentResponseError) return;
            const state = agentErrorState(error);
            if (state) applyConversationState(state);
            addEventLog(rt("newConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("newConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    const resumeThread = async (threadId: string) => {
        const current = useAgentStore.getState();
        if (!current.connected || !threadId || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        try {
            const result = await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/${engineId}/threads/${encodeURIComponent(threadId)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(engineId === "codex" && permissionMode ? { permissionMode } : {}), clientId: clientIdRef.current }) });
            setAgentState({ modelChanged: false, permissionChanged: false });
            if (result.conversation) applyConversationState(result.conversation);
            await loadThreads();
            if (useAgentStore.getState().activeThreadId === threadId) setAgentState({ activeTab: "chat", activity: rt("conversationResumed") });
        } catch (error) {
            if (error instanceof StaleAgentResponseError) return;
            const state = agentErrorState(error);
            if (state) applyConversationState(state);
            addEventLog(rt("resumeConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("resumeConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    const deleteThreads = async (threadIds: string[]) => {
        if (!connected || !threadIds.length || sending || waiting || loadingThreads) return;
        const operation = beginThreadOperation();
        let deletedCount = 0;
        try {
            for (const threadId of new Set(threadIds)) {
                await fetchAgentJson(endpoint, token, `/agent/${engineId}/threads/${encodeURIComponent(threadId)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current }) });
                threadMessagesRef.current.delete(threadId);
                deletedCount += 1;
            }
            await loadThreads();
            message.success(rt("recordsDeleted", { count: deletedCount }));
        } catch (error) {
            if (error instanceof StaleAgentResponseError) return;
            await loadThreads();
            addEventLog(rt("deleteConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("deleteConversationFailed"));
        } finally {
            finishThreadOperation(operation);
        }
    };

    const confirmDeleteThreads = (threadIds: string[]) => {
        const scope = getAgentScope();
        modal.confirm({
            title: rt("deleteConversations", { count: threadIds.length }),
            content: rt("deleteConversationsDescription"),
            okText: t("common.delete"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: () => { if (isCurrentAgentScope(scope)) return deleteThreads(threadIds); },
        });
    };

    const addMessage = (item: Omit<AgentChatItem, "id"> & { id?: string }) => {
        const text = normalizeText(item.text);
        if (!text && !item.attachments?.length) return;
        const current = useAgentStore.getState();
        const itemId = item.itemId || item.id || createId();
        const next = scopeChatItem({ ...item, id: item.id || itemId, itemId, text } as AgentChatItem, item.threadId ?? current.activeThreadId, item.turnId ?? current.activeTurnId);
        setAgentState({ messages: upsertAgentMessage(current.messages, next) });
    };

    const addEventLog = (title: string, text: unknown, raw?: unknown) => {
        const value = normalizeText(text) || title;
        const last = useAgentStore.getState().eventLogs.at(-1);
        if (last?.title === title && last.text === value) return;
        pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: dayjs().format("YYYY-MM-DD HH:mm:ss"), title, text: value, raw });
    };

    const upsertActivityMessage = (item: AgentChatItem) => {
        setAgentState({ messages: upsertAgentMessage(useAgentStore.getState().messages, item) });
    };

    const appendActivityDelta = (event: AgentEventPayload) => {
        const item = event.item;
        if (!item?.id) return;
        const text = stringText(item.text) || stringText(item.delta);
        const isDelta = Boolean(stringText(item.delta));
        if (!text) return;
        if (item.type === "reasoning") {
            const scoped = scopeEventChatItem(event, activityDeltaFallback(item, text), "synthetic:reasoning");
            const current = useAgentStore.getState().messages.find((message) => message.id === scoped.id);
            const activityItems = { ...(current?.activityItems || {}) };
            const previous = activityItems[item.id] || "";
            activityItems[item.id] = isDelta ? `${previous === activityPlaceholder("reasoning") ? "" : previous}${text}` : text;
            upsertActivityMessage({ ...scoped, title: i18n.t("agent.events.reasoning"), text: reasoningActivityText(activityItems), activityItems, detail: activityDetail(current?.detail || scoped.detail, "reasoning", "inProgress") });
            return;
        }
        const scoped = scopeEventChatItem(event, activityDeltaFallback(item, text), item.id);
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scoped.id);
        if (index < 0) {
            if (!text.trim()) return;
            upsertActivityMessage(scoped);
            return;
        }
        const current = currentMessages[index];
        if (item.type === "command_execution") {
            const detail = activityDetail(current.detail, "command", "inProgress");
            detail.output = isDelta ? `${stringText(detail.output)}${text}` : text;
            setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, detail } : message) });
            return;
        }
        const placeholder = activityPlaceholder(item.type);
        if (!text.trim() && current.text === placeholder) return;
        const nextText = isDelta ? `${current.text === placeholder ? "" : current.text}${text}` : mergeStreamText(current.text, text);
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: nextText, detail: { ...activityDetail(message.detail, activityKind(item.type), "inProgress") } } : message) });
    };

    const upsertEventActivity = (event: AgentEventPayload, item: Omit<AgentChatItem, "id">) => {
        const itemId = event.item?.id;
        if (!itemId) return;
        if (event.item?.type === "reasoning") {
            const scoped = scopeEventChatItem(event, { ...item, id: "synthetic:reasoning" }, "synthetic:reasoning");
            const current = useAgentStore.getState().messages.find((message) => message.id === scoped.id);
            const activityItems = { ...(current?.activityItems || {}) };
            const previous = activityItems[itemId] || "";
            const incoming = normalizeText(item.text);
            activityItems[itemId] = incoming === "已完成分析" && previous && previous !== activityPlaceholder("reasoning") ? previous : incoming;
            upsertActivityMessage({ ...scoped, title: i18n.t("agent.events.reasoning"), text: reasoningActivityText(activityItems, incoming), activityItems });
            return;
        }
        upsertActivityMessage(scopeEventChatItem(event, { ...item, id: itemId }, itemId));
    };

    const finishEmptyReasoningActivity = (event: AgentEventPayload) => {
        const itemId = event.item?.id;
        if (!itemId) return;
        const scopedId = scopeEventChatItem(event, { id: "synthetic:reasoning", role: "tool", text: "" }, "synthetic:reasoning").id;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scopedId);
        if (index < 0) return;
        const current = currentMessages[index];
        const activityItems = { ...(current.activityItems || {}) };
        delete activityItems[itemId];
        if (!Object.values(activityItems).some(isReasoningSummary)) {
            setAgentState({ messages: currentMessages.filter((_, itemIndex) => itemIndex !== index) });
            return;
        }
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: reasoningActivityText(activityItems), activityItems, detail: activityDetail(message.detail, "reasoning", "completed") } : message) });
    };

    const finishPlanActivity = (event: AgentEventPayload) => {
        const id = scopeEventChatItem(event, { id: "synthetic:plan", role: "tool", text: "" }, "synthetic:plan").id;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === id);
        if (index < 0) return;
        const current = currentMessages[index];
        const detail = activityDetail(current.detail, "todo", turnPlanStatus(current.detail, event.status));
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, detail } : message) });
    };

    const showAgentError = (value: unknown, event?: AgentEventPayload, log = true) => {
        const error = agentErrorView(value);
        const item = event
            ? scopeEventChatItem(event, { id: "synthetic:error", role: "error", title: error.title, text: error.text }, "synthetic:error")
            : scopeChatItem({ id: createId(), role: "error", title: error.title, text: error.text }, useAgentStore.getState().activeThreadId, useAgentStore.getState().activeTurnId);
        const state = useAgentStore.getState();
        const current = state.messages.find((message) => message.id === item.id);
        if (current && !normalizeText(value)) return;
        upsertActivityMessage(item);
        setAgentState({ activity: rt("processingFailed"), pendingApprovals: [] });
        if (log) addEventLog(rt("processingFailed"), error.text, value);
    };

    const handleAgentEvent = async (event: AgentEventPayload) => {
        const requestScope = getAgentScope();
        if (event.type === "usage.updated") setAgentState({ tokenUsage: eventUsage(event) });
        const log = event.replayed ? null : formatAgentEventLog(event);
        const activity = formatAgentActivity(event);
        if (log) addEventLog(log.title, log.text);
        if (event.type === "turn.started" && (event.turnId || event.turn_id)) {
            const scope = eventScope(event);
            const current = useAgentStore.getState();
            if (!scope.threadId || !scope.turnId) return;
            liveTurnKeysRef.current.add(`${scope.threadId}\0${scope.turnId}`);
            setAgentState({ activeTurnId: scope.turnId, bootstrapStatus: null, mcpStartupStatuses: {}, messages: bindPendingTurnMessages(current.messages, scope.threadId, scope.turnId) });
        }
        if (event.type === "item.updated" && event.item?.type === "agent_message" && event.item.id) {
            const delta = stringText(event.item.delta);
            appendStreamText(event, delta || stringText(event.item.text), Boolean(delta));
            return;
        }
        if (event.type === "item.updated" && event.item) {
            appendActivityDelta(event);
            return;
        }
        if (event.type === "plan.updated" && event.turn_id) {
            const plan = formatAgentPlan(event);
            if (plan) upsertActivityMessage(scopeEventChatItem(event, { ...plan, id: "synthetic:plan" }, "synthetic:plan"));
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "error") {
            showAgentError(event.item.message, event, !event.replayed);
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.id) {
            const scoped = scopeEventChatItem(event, { id: event.item.id, role: "assistant", title: "Codex", text: stringText(event.item.text) }, event.item.id);
            const currentMessages = useAgentStore.getState().messages;
            const index = currentMessages.findIndex((message) => message.id === scoped.id);
            if (index >= 0) {
                const text = stringText(event.item.text);
                setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: text || message.text, streamId: undefined } : message) });
                return;
            }
            addMessage(scoped);
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "reasoning" && !activity) {
            finishEmptyReasoningActivity(event);
            return;
        }
        if (event.type === "item.completed" && !activity && event.item?.id && event.item.type === "plan") {
            const id = scopeEventChatItem(event, { id: event.item.id, role: "tool", text: "" }, event.item.id).id;
            setAgentState({ messages: useAgentStore.getState().messages.filter((item) => item.id !== id) });
            return;
        }
        if (!event.replayed && event.type === "item.completed" && event.item?.type === "image_generation" && event.item.id && event.sourceClientId === clientIdRef.current) {
            const generated = await importGeneratedImages(endpoint, token, event.item);
            if (!isCurrentAgentScope(requestScope)) return;
            if (generated.length) {
                const context = canvasContextRef.current;
                if (context) {
                    const right = Math.max(0, ...context.snapshot.nodes.map((node) => node.position.x + node.width)) + 80;
                    const ops = generated.map<CanvasAgentOp>((image, index) => {
                        const size = fitNodeSize(image.upload.width, image.upload.height);
                        return {
                            type: "add_node",
                            id: `image-${createId()}`,
                            nodeType: "image",
                            title: image.name,
                            position: { x: right + index * 40, y: index * 40 },
                            ...size,
                            metadata: imageMetadata(image.upload),
                        };
                    });
                    const result = context.applyOps(ops);
                    void postState(endpoint, token, clientIdRef.current, result);
                }
                addEventLog(rt("importGeneratedImages"), rt(context ? "addedToSourceCanvas" : "imageGenerated"));
            }
        }
        if (activity && event.item?.id) {
            upsertEventActivity(event, activity);
            return;
        }
        if (event.type === "turn.completed") {
            const scope = eventScope(event);
            if (scope.turnId) {
                finishPlanActivity(event);
                liveTurnKeysRef.current.add(`${scope.threadId}\0${scope.turnId}`);
            }
            const current = useAgentStore.getState();
            setAgentState({
                activeTurnId: current.activeTurnId === scope.turnId ? "" : current.activeTurnId,
                messages: current.messages.map((message) => message.threadId === scope.threadId && message.turnId === scope.turnId && message.streamId ? { ...message, streamId: undefined } : message),
            });
            if (event.status === "failed") showAgentError(event.error?.message, event, !event.replayed);
        }
        const item = formatAgentEvent(event);
        if (item) addMessage(scopeEventChatItem(event, { ...item, id: event.item?.id || createId() }, event.item?.id || createId()));
    };

    const appendStreamText = (event: AgentEventPayload, text: string, isDelta = false) => {
        if (!text) return;
        const itemId = event.item?.id;
        if (!itemId) return;
        const scoped = scopeEventChatItem(event, { id: itemId, role: "assistant", title: "Codex", text, streamId: itemId }, itemId);
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scoped.id);
        if (index < 0) {
            pushMessage(scoped);
            return;
        }
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: isDelta ? `${message.text}${text}` : mergeStreamText(message.text, text) } : message) });
    };

    const connectionStatus = t(connectError ? "agent.status.failed" : connected ? "agent.status.connected" : enabled ? "agent.status.connecting" : "agent.status.disconnected");
    const connectionStatusColor = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : theme.node.muted;
    let engineSwitchHint = t("agentEngines.select");
    if (!connected) engineSwitchHint = t("agentEngines.connectFirst");
    else if (conversation.status === "preparing") engineSwitchHint = t("agentEngines.initializing", { engine: currentEngine?.name || "Codex" });
    else if (engineBusy) engineSwitchHint = t("agentEngines.busy");
    const content = (
        <>
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                leading={
                    <div className="flex items-center gap-1">
                        <span className="grid size-8 place-items-center">
                            <Bot className="size-4" />
                        </span>
                        <Tooltip title={engineSwitchHint} placement="bottom">
                            <span className="inline-flex">
                                <Dropdown trigger={["click"]} disabled={!connected || engineBusy} menu={{ selectedKeys: [engineId], items: engines.map((engine) => ({ key: engine.id, label: engine.name, onClick: () => void switchEngine(engine.id) })) }}>
                                    <button type="button" disabled={!connected || engineBusy} aria-label={t("agentEngines.select")} className="flex h-8 items-center gap-1 rounded px-1 text-sm font-semibold hover:bg-black/5 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/10">
                                        {switchingEngine ? <span>{t("agentEngines.switching")}</span> : currentEngine?.name || "Codex"}<ChevronDown className="size-3 opacity-60" />
                                    </button>
                                </Dropdown>
                            </span>
                        </Tooltip>
                        <Tooltip title={t("agent.panel.connectionSettings", { status: connectionStatus })} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.panel.connectionSettingsLabel", { status: connectionStatus })} icon={<PlugZap className="size-3.5" style={{ color: connectionStatusColor }} />} onClick={() => setAgentState({ activeTab: "setup" })}>
                                <span className="hidden @min-[560px]:inline">{connectionStatus}</span>
                            </Button>
                        </Tooltip>
                    </div>
                }
                items={[
                    { value: "chat", label: t("agent.panel.chat"), icon: <MessageSquare className="size-3.5" /> },
                    { value: "history", label: t("agent.panel.history"), icon: <History className="size-3.5" />, count: threads.length },
                    { value: "skills", label: t("agent.panel.skills"), icon: <Sparkles className="size-3.5" />, count: skillCount },
                    { value: "log", label: t("agent.panel.logs"), icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadThreads();
                }}
                right={
                    <>
                        {currentEngine?.capabilities.manageSettings ? <Tooltip title={t("agentEngines.settings")}><Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0" disabled={!connected || engineBusy} aria-label={t("agentEngines.settings")} icon={<Settings className="size-3.5" />} onClick={() => void manageSettings()} /></Tooltip> : null}
                        <Tooltip title={t("agent.history.newThread")} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.history.newThread")} disabled={!connected || loadingThreads || sending || waiting || conversationBusy} icon={<Plus className="size-3.5" />} onClick={startNewThread}>
                                <span className="hidden @min-[560px]:inline">{t("agent.history.newThread")}</span>
                            </Button>
                        </Tooltip>
                        <Tooltip title={t("agent.panel.collapse")}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.panel.collapseLabel")} style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} />
                        </Tooltip>
                    </>
                }
            />

            {activeTab === "setup" ? (
                <AgentConnectView
                    theme={theme}
                    url={url}
                    token={token}
                    enabled={enabled}
                    connected={connected}
                    activity={activity}
                    connectError={connectError}
                    onUrlChange={(url) => setAgentState({ url, connectError: "" })}
                    onTokenChange={(token) => setAgentState({ token, connectError: "" })}
                    onToggleEnabled={toggleAgentConnection}
                    onConfigProfileChange={(profile) => void switchConfigProfile(profile)}
                />
            ) : activeTab === "skills" ? (
                <AgentSkillsView key={`${engineId}:${runtimeId}`} clientId={clientIdRef.current} />
            ) : activeTab === "history" ? (
                <AgentHistoryView
                    key={`${engineId}:${runtimeId}`}
                    theme={theme}
                    threads={threads}
                    activeThreadId={activeThreadId}
                    workspacePath={workspacePath}
                    loading={loadingThreads}
                    busy={engineBusy}
                    connected={connected}
                    onRefresh={() => void loadThreads()}
                    onNewThread={() => void startNewThread()}
                    onResumeThread={(threadId) => void resumeThread(threadId)}
                    onDeleteThreads={confirmDeleteThreads}
                />
            ) : activeTab === "log" ? (
                <AgentLogView
                    key={`${engineId}:${runtimeId}`}
                    logs={eventLogs}
                    theme={theme}
                    context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messageCount, pendingTool: pendingTool?.name }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    <AgentChatTimeline key={`${engineId}:${runtimeId}`} theme={theme} pendingTool={pendingTool} pendingApprovals={pendingApprovals} sending={sending} waiting={waiting} onRejectTool={rejectPendingTool} onApproveTool={approvePendingTool} onApprovalDecision={decideApproval} />
                    <AgentTaskProgress theme={theme} busy={sending || waiting} />
                    {tokenUsage ? <AgentUsageBar usage={tokenUsage} theme={theme} /> : null}
                    <AgentChatComposer
                        key={`${engineId}:${runtimeId}`}
                        prompt={prompt}
                        attachments={attachments.map((attachment) => agentAttachmentToChatAttachment(attachment, endpoint, token))}
                        disabled={!connected || !conversationReady || engineBusy}
                        sending={sending || waiting}
                        placeholder={conversation.status === "idle" || conversation.status === "preparing"
                            ? t("agent.panel.mcpInitializing")
                            : conversation.status === "failed"
                                ? t("agentEngines.initFailed")
                                : t("agentEngines.placeholder", { engine: currentEngine?.name || "Codex" })}
                        theme={theme}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                        onStop={stopTurn}
                        onAddFiles={currentEngine?.capabilities.attachments ? addAttachments : undefined}
                        onRemoveAttachment={removeAttachment}
                        confirmTools={confirmTools}
                        onConfirmToolsChange={(confirmTools) => setAgentState({ confirmTools })}
                        permissionMode={permissionMode}
                        onPermissionModeChange={changePermissionMode}
                        models={models}
                        model={model}
                        reasoningEffort={reasoningEffort}
                        onModelChange={(model) => {
                            const selected = models.find((item) => (item.id || item.model) === model);
                            if (!selected) return;
                            const effort = selected.defaultReasoningEffort || selected.supportedReasoningEfforts[0]?.reasoningEffort || "";
                            preferences.setItem(enginePreferenceKey(engineId, "model"), model);
                            preferences.setItem(enginePreferenceKey(engineId, "effort"), effort);
                            setAgentState({ model, reasoningEffort: effort, modelChanged: true });
                        }}
                        onReasoningEffortChange={(reasoningEffort) => {
                            preferences.setItem(enginePreferenceKey(engineId, "effort"), reasoningEffort);
                            setAgentState({ reasoningEffort, modelChanged: true });
                        }}
                        left={
                            attachments.length ? (
                                <span className="hidden text-[11px] @min-[660px]:inline" style={{ color: theme.node.muted }}>
                                    {formatBytes(attachmentPayloadBytes(attachments))} / 30MB
                                </span>
                            ) : null
                        }
                    />
                </>
            )}
        </>
    );

    if (headless) return null;
    return embedded ? content : null;
}

function acquireAgentClientId() {
    const scope = globalThis as AgentClientGlobal;
    scope.__infiniteCanvasAgentClientIdPromise ||= (async () => {
        const storedClientId = readAgentClientId();
        let clientId = storedClientId || randomId();
        if (!navigator.locks) {
            if (!storedClientId) saveAgentClientId(clientId);
            return clientId;
        }
        while (true) {
            const acquired = await new Promise<boolean>((resolve, reject) => {
                void navigator.locks.request(`infinite-canvas-agent:${clientId}`, { ifAvailable: true }, async (lock) => {
                    if (!lock) return resolve(false);
                    resolve(true);
                    await new Promise<void>(() => undefined);
                }).catch(reject);
            });
            if (acquired) {
                saveAgentClientId(clientId);
                return clientId;
            }
            clientId = randomId();
        }
    })().catch(() => {
        const clientId = randomId();
        saveAgentClientId(clientId);
        return clientId;
    });
    return scope.__infiniteCanvasAgentClientIdPromise;
}

function readAgentClientId() {
    try {
        return sessionStorage.getItem("canvas-agent-client-id") || "";
    } catch {
        return "";
    }
}

function saveAgentClientId(clientId: string) {
    try {
        sessionStorage.setItem("canvas-agent-client-id", clientId);
    } catch {
        // The in-memory identity still keeps request ownership consistent within the current page session.
    }
}

function eventScope(event: AgentEventPayload) {
    return {
        threadId: event.threadId || event.thread_id || "",
        turnId: event.turnId || event.turn_id || "",
    };
}

function scopeEventChatItem(event: AgentEventPayload, item: AgentChatItem, itemId: string) {
    const scope = eventScope(event);
    return scopeChatItem({ ...item, itemId }, scope.threadId, scope.turnId);
}

function approvalActivity(pendingApprovals: AgentPendingApproval[], waiting: boolean, fallback: string) {
    if (pendingApprovals.length) return rt("awaitingApproval");
    return waiting ? rt("codexRunning") : fallback;
}

async function attachmentNodeOps(endpoint: string, token: string, clientId: string, value: unknown): Promise<CanvasAgentOp[]> {
    const nodes = Array.isArray(value) ? value : [];
    if (!nodes.length) throw new Error(rt("noImageAttachments"));
    return await Promise.all(
        nodes.map(async (value) => {
            const item = value as { id?: unknown; attachmentId?: unknown; title?: unknown; position?: unknown };
            const id = String(item.id || "");
            const attachmentId = String(item.attachmentId || "");
            if (!id || !attachmentId) throw new Error(rt("invalidAttachmentNode"));
            const res = await fetch(`${endpoint}/agent/attachments/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error || rt("attachmentReadFailed"));
            }
            const image = await uploadImage(await res.blob());
            const size = fitNodeSize(image.width, image.height);
            const position = item.position && typeof item.position === "object" ? (item.position as { x?: unknown; y?: unknown }) : {};
            return {
                type: "add_node" as const,
                id,
                nodeType: "image" as const,
                title: String(item.title || rt("referenceImage")),
                position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
                width: size.width,
                height: size.height,
                metadata: imageMetadata(image),
            };
        }),
    );
}

function createId() {
    return randomId();
}

async function createMessageAttachmentMetadata(item: AgentAttachment) {
    const url = Math.max(item.width, item.height) > MESSAGE_PREVIEW_LONG_EDGE || item.dataUrl.length > MESSAGE_PREVIEW_MAX_LENGTH
        ? await upscaleDataUrl(item.dataUrl, { targetLongEdge: MESSAGE_PREVIEW_LONG_EDGE, algorithm: "high" })
        : item.dataUrl;
    return { id: item.id, name: item.name, type: item.type, size: item.size, width: item.width, height: item.height, url };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

async function importGeneratedImages(endpoint: string, token: string, item: AgentEventItem) {
    const sources = Array.from(generatedImageSources(item));
    return await Promise.all(
        sources.map(async (source, index) => {
            const response = source.startsWith("data:image/")
                ? await fetch(source)
                : await fetch(`${endpoint}/agent/local-image?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: source }) });
            if (!response.ok) throw new Error(rt("generatedImageReadFailed"));
            const blob = await response.blob();
            const upload = await uploadImage(blob);
            const dataUrl = await readDataUrl(blob);
            const name = source.startsWith("/") ? source.split("/").at(-1) || rt("generatedImageName", { index: index + 1 }) : rt("generatedImageName", { index: index + 1 });
            return { upload, name, attachment: { id: createId(), name, type: blob.type || upload.mimeType, size: blob.size, width: upload.width, height: upload.height, url: upload.url, dataUrl } };
        }),
    );
}

function generatedImageSources(value: unknown, result = new Set<string>()) {
    if (typeof value === "string") {
        if (value.startsWith("data:image/") || (/^\/.+\.(?:avif|gif|jpe?g|png|webp)$/i.test(value) && !value.includes("\n"))) result.add(value);
        return result;
    }
    if (Array.isArray(value)) value.forEach((item) => generatedImageSources(item, result));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => generatedImageSources(item, result));
    return result;
}

function readDataUrl(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error(rt("imageReadFailed")));
        reader.readAsDataURL(file);
    });
}

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
