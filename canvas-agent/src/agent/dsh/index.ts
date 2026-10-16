import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import open from "open";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionRequestId, PromptContentPart, ModelSelection, ModelCatalog } from "@deepseek-ai/dsh-api-session-controller/types";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval/types";
import type { AttachmentIdType } from "@deepseek-ai/dsh-attachment";
import type {} from "@deepseek-ai/dsh-user-questions/types";
import type { AgentAttachment, AgentEmit } from "../types.js";
import { OwnedDshRuntime, type OwnedRuntimeOptions } from "./owned-runtime.js";
import { createDshConnection, unwrapDsh } from "./transport.js";
import { DshSession } from "./sessions.js";
import { record, text, type DshEvent } from "./history.js";
import { redactSkillSourceText } from "../../skills/draft.js";

export type DshRunOptions = { threadId?: string; model?: string; provider?: string; effort?: string; permissionMode?: string; clientMessageId?: string; onThread?: (id: string) => void; onTurn?: (id: string) => void; onFinish?: () => void };
type DshDraftInput = { source: "conversation" | "canvas"; threadId?: string; prompt: string; outputSchema?: unknown; model?: string; provider?: string; effort?: string; signal?: AbortSignal };
type DshOptions = Omit<OwnedRuntimeOptions, "runtimeId"> & { runtimeId?: string; openExternal?: (url: string) => Promise<unknown> };
type PendingApproval = { threadId: string; turnId: string; resolve(outcome: ApprovalOutcome): void };

/** Native DSH BFF. Credentials, history, model routing and permission policy stay DSH-owned. */
export class DshAgent {
    readonly runtimeId: string;
    private owned: OwnedDshRuntime;
    private opening?: Promise<void>;
    private connection?: Awaited<ReturnType<typeof createDshConnection>>;
    private sessions = new Map<string, DshSession>();
    private drafts = new Set<string>();
    private approvals = new Map<string, PendingApproval>();
    private active?: { threadId: string; options: DshRunOptions; task?: Promise<void> };
    private permissions: Array<{ id: string; title: string; description?: string }> = [];
    private defaultPermission?: string;
    private catalogSessionId?: string;
    private closed = false;
    private closing?: Promise<void>;

    constructor(private readonly options: DshOptions) {
        this.runtimeId = options.runtimeId || crypto.randomUUID();
        this.owned = new OwnedDshRuntime({ ...options, runtimeId: this.runtimeId });
    }
    get capabilities() { return { permissions: this.permissions, defaultPermissionMode: this.defaultPermission, skills: true, attachments: true, manageSettings: true }; }

    async start() {
        if (this.closed) throw new Error("DSH 已关闭，请重新连接");
        if (this.opening && this.owned.isStopped) {
            if (this.active) throw new Error("DSH 进程已退出，正在结束当前任务");
            await Promise.all([...this.sessions.values()].map((session) => session.close()));
            this.sessions.clear();
            await this.connection?.close(); this.connection = undefined;
            await this.owned.close();
            if (!this.closed) this.owned = new OwnedDshRuntime({ ...this.options, runtimeId: this.runtimeId });
            this.opening = undefined;
        }
        if (this.opening) return this.opening;
        this.opening = this.connect();
        try { await this.opening; }
        catch (error) {
            await this.connection?.close();
            this.connection = undefined;
            await this.owned.close();
            this.sessions.clear();
            if (!this.closed) this.owned = new OwnedDshRuntime({ ...this.options, runtimeId: this.runtimeId });
            this.opening = undefined;
            throw error;
        }
    }

    private async connect() {
        this.connection = await createDshConnection(await this.owned.start());
        if (this.closed) { await this.connection.close(); throw new Error("DSH 正在关闭"); }
        const { ctx, sessionIdOf } = this.connection;
        ctx.remote.$on("approval/request", async (request, next) => {
            const nativeSessionId = Context.is(request.agent) ? sessionIdOf(request.agent) : undefined;
            if (!nativeSessionId) return next();
            if (this.drafts.has(nativeSessionId)) return "rejected";
            const active = this.active;
            const threadId = active?.threadId;
            if (!threadId || !await this.owned.request("approval.owner", { sessionId: nativeSessionId, rootSessionId: threadId })) return next();
            if (this.active !== active || request.signal?.aborted) return "cancelled";
            const requestId = crypto.randomUUID();
            const turnId = this.sessions.get(threadId)!.history.currentTurn;
            const scope = { engineId: "dsh", runtimeId: this.runtimeId, threadId, turnId };
            const decision = await new Promise<ApprovalOutcome>((resolve) => {
                const finish = (outcome: ApprovalOutcome) => { request.signal?.removeEventListener("abort", abort); this.approvals.delete(requestId); resolve(outcome); };
                const abort = () => finish("cancelled");
                this.approvals.set(requestId, { threadId, turnId, resolve: finish });
                request.signal?.addEventListener("abort", abort, { once: true });
                if (request.signal?.aborted) abort();
                else this.options.emit("dsh_approval", { ...scope, nativeSessionId, requestId, method: "approval/request", itemId: request.callId, toolName: request.toolName, reason: request.reason, decisions: [{ value: "allowed-once", label: "允许一次" }, { value: "rejected", label: "拒绝" }] });
            });
            this.options.emit("dsh_approval_resolved", { ...scope, requestId, decision });
            return decision;
        });
        ctx.remote.$on("permission-presets/catalog-changed", () => { void this.refreshPermissions().catch(() => this.emit({ type: "runtime.error", engineId: "dsh", runtimeId: this.runtimeId, threadId: this.active?.threadId || "", turnId: "", message: "DSH 权限目录刷新失败" })); });
        ctx.remote.$on("api-session/error", (id, message) => this.emit({ type: "runtime.error", engineId: "dsh", runtimeId: this.runtimeId, threadId: id, turnId: this.sessions.get(id)?.history.currentTurn || "", message }));
        await this.refreshPermissions();
    }

    private async refreshPermissions() {
        const catalog = unwrapDsh(await this.connection!.ctx.remote.permissionPresets.catalog());
        this.permissions = catalog.options.map((option) => ({ id: option.value, title: option.name, ...(option.description ? { description: option.description } : {}) }));
        this.defaultPermission = catalog.defaultPreset;
    }
    private get remote() { if (!this.connection) throw new Error("DSH 尚未连接"); return this.connection.ctx.remote; }
    private emit(event: DshEvent) {
        if (this.closed || this.drafts.has(event.threadId)) return;
        if (event.type === "turn.started" && event.threadId === this.active?.threadId) this.active.options.onTurn?.(event.turnId);
        this.options.emit("dsh_event", event);
    }

    private async session(id: string) {
        await this.start();
        let session = this.sessions.get(id);
        if (!session) { session = new DshSession(this.remote, this.runtimeId, SessionId(id), (event) => this.emit(event)); this.sessions.set(id, session); }
        try { await session.ready(); }
        catch (error) { this.sessions.delete(id); await session.close(); throw error; }
        const cwd = session.header?.cwd;
        if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory()) throw new Error("DSH 会话原有工作空间不可用");
        return session;
    }

    async models() {
        await this.start();
        const catalog = unwrapDsh(await this.remote.session.modelCatalog());
        return { data: catalog.groups.flatMap((provider) => provider.models.map((model) => ({
            id: JSON.stringify([provider.id, model.id]), model: model.id, provider: provider.id, displayName: model.name, description: model.description,
            isDefault: catalog.default.provider === provider.id && catalog.default.model === model.id,
            defaultReasoningEffort: model.reasoning?.defaultEffort || "", supportedReasoningEfforts: model.reasoning?.efforts.map((effort) => ({ reasoningEffort: effort.id, description: effort.description || effort.name })) || [],
        }))), failures: catalog.failures, default: catalog.default };
    }

    private async workspaceBaseline() {
        const stream = this.remote.workspace.follow();
        try {
            for await (const frame of stream) if (frame.type === "baseline") return frame.value;
            throw new Error("DSH 工作空间流缺少基线");
        } finally { stream.dispose(); }
    }

    async threads(options: { searchTerm?: string; limit?: number } = {}) {
        await this.start();
        const [result, workspace] = await Promise.all([this.remote.session.list({}).then(unwrapDsh), this.workspaceBaseline()]);
        const archived = new Set(workspace.archivedSessionIds);
        let matching: Set<string> | undefined;
        if (options.searchTerm) matching = new Set(unwrapDsh(await this.remote.session.search({ query: options.searchTerm })).items.map((item) => item.sessionId));
        const normalizedPath = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
        const cwd = normalizedPath(this.options.workspacePath);
        const rows = result.items.filter((item) => item.cwd && normalizedPath(item.cwd) === cwd && item.origin !== "subagent" && !archived.has(item.sessionId) && !this.drafts.has(item.sessionId) && (!matching || matching.has(item.sessionId)));
        const values = options.limit ? rows.slice(0, options.limit) : rows;
        return { data: values.map((item) => ({ id: item.sessionId, cwd: item.cwd, updatedAt: item.updatedAt, preview: text(record(item.projections?.values).title) || "DSH 对话", running: item.running, engineId: "dsh", runtimeId: this.runtimeId })), nextCursor: null };
    }

    async readThread(id: string) {
        const session = await this.session(id);
        const messages = session.history.messages();
        const projections = unwrapDsh(await this.remote.session.projections({ sessionId: SessionId(id) }));
        const selection = record(record(projections?.values).modelSelection);
        const nativeSelection = record(selection.next || selection.lastUsed);
        const modelSelection = nativeSelection.model ? { provider: text(nativeSelection.provider), model: text(nativeSelection.model), effort: text(nativeSelection.reasoningEffort) } : undefined;
        const permissionMode = text(record(record(projections?.values).permissions).currentValue) || undefined;
        return { thread: { id, cwd: session.header!.cwd, createdAt: session.header!.createdAt, preview: text(record(projections?.values).title) || messages.find((item) => item.role === "user")?.text || "DSH 对话", modelSelection, permissionMode, engineId: "dsh", runtimeId: this.runtimeId }, modelSelection, permissionMode, messages, settledTurnIds: session.history.settledTurnIds(), historyReady: true };
    }

    async newThread(options: { permissionMode?: string; model?: string; provider?: string; effort?: string } = {}) {
        await this.start();
        const workspace = unwrapDsh(await this.remote.workspace.create({ path: this.options.workspacePath })).workspace;
        const created = unwrapDsh(await this.remote.session.create({ workspaceId: workspace.workspaceId }));
        await this.session(created.sessionId);
        await this.configure(created.sessionId, options);
        return this.readThread(created.sessionId);
    }

    async resumeThread(id: string) {
        await this.session(id);
        await this.owned.request("session.resume", { sessionId: id });
        return this.readThread(id);
    }

    async archiveThread(id: string) {
        await this.session(id);
        unwrapDsh(await this.remote.workspace.archiveSession({ sessionId: SessionId(id) }));
        await this.sessions.get(id)?.close();
        this.sessions.delete(id);
    }

    async readAttachment(threadId: string, attachmentId: string) {
        const session = await this.session(threadId);
        if (!session.history.messages().some((message) => message.attachments?.some((attachment) => attachment.id === attachmentId))) throw Object.assign(new Error("DSH 附件不属于指定会话"), { statusCode: 404 });
        return unwrapDsh(await this.remote.session.attachment({ sessionId: SessionId(threadId), attachmentId: attachmentId as AttachmentIdType }));
    }

    private async configure(id: string, options: { permissionMode?: string; model?: string; provider?: string; effort?: string }) {
        if (options.permissionMode) {
            if (!this.permissions.some((permission) => permission.id === options.permissionMode)) throw new Error("DSH 权限预设不存在，请刷新后重试");
            const executed = unwrapDsh(await this.remote.commands.execute(SessionId(id), `/permission ${options.permissionMode}`, []));
            if (!executed || executed.result.kind === "error") throw new Error(text(executed?.result.text) || "DSH 权限预设切换失败");
        }
        if (options.model || options.effort || options.provider) {
            const catalog = unwrapDsh(await this.remote.session.modelCatalog());
            const projections = unwrapDsh(await this.remote.session.projections({ sessionId: SessionId(id) }));
            const native = record(record(projections?.values).modelSelection);
            const current = record(native.next || native.lastUsed);
            const fallback = current.provider && current.model ? { provider: text(current.provider), model: text(current.model) } : catalog.default;
            const selection = this.modelSelection(catalog, options, fallback);
            unwrapDsh(await this.remote.session.selectModel({ sessionId: SessionId(id), ...selection }));
        }
    }

    private modelSelection(catalog: ModelCatalog, options: { model?: string; provider?: string; effort?: string }, fallback: ModelSelection = catalog.default): ModelSelection {
        const routes = catalog.groups.flatMap((group) => group.models.map((model) => ({ provider: group.id, model: model.id })));
        const matching = routes.filter((route) => (!options.provider || route.provider === options.provider) && (!options.model || route.model === options.model));
        const route = options.model ? (matching.length === 1 ? matching[0] : undefined) : routes.find((candidate) => candidate.provider === (options.provider || fallback.provider) && candidate.model === fallback.model);
        if (!route) throw new Error("DSH 模型路由不明确或不可用");
        return { provider: route.provider, model: route.model, ...(options.effort ? { reasoningEffort: options.effort } : {}) };
    }

    async runTurn(prompt: string, attachments: AgentAttachment[] = [], options: DshRunOptions = {}) {
        if (this.active) throw new Error("DSH 正在运行另一个任务");
        const id = options.threadId || (await this.newThread()).thread.id;
        const session = await this.session(id);
        await this.owned.request("session.resume", { sessionId: id });
        await this.configure(id, options);
        options.onThread?.(id);
        const active = this.active = { threadId: id, options, task: undefined as Promise<void> | undefined };
        active.task = (async () => {
            const content: PromptContentPart[] = [{ type: "text", text: prompt }];
            for (const attachment of attachments) {
                const image = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(attachment.dataUrl || "");
                if (!image) throw new Error("DSH 仅接受 PNG、JPEG、WebP 或 GIF 图片附件");
                content.push({ type: "image", mediaType: image[1] as "image/png", data: image[2], ...(attachment.name ? { name: attachment.name } : {}) });
            }
            await this.owned.request("turn.bind", { sessionId: id });
            try {
                unwrapDsh(await this.remote.session.prompt({ sessionId: SessionId(id), requestId: (options.clientMessageId || crypto.randomUUID()) as SessionRequestId, mode: "queue", content }));
                const result = record(await this.owned.request("session.quiesce", { sessionId: id }));
                if (typeof result.seq === "number") await session.through(result.seq - 1);
            } catch (error) {
                await this.owned.request("session.quiesce", { sessionId: id, cancel: true });
                throw error;
            } finally { await this.owned.request("turn.release", { sessionId: id }); }
        })();
        try { await active.task; }
        finally { if (this.active === active) this.active = undefined; options.onFinish?.(); }
    }

    async interrupt(threadId = this.active?.threadId) {
        if (!threadId || this.active?.threadId !== threadId) return false;
        unwrapDsh(await this.remote.session.cancel({ sessionId: SessionId(threadId) }));
        await this.owned.request("session.quiesce", { sessionId: threadId, cancel: true });
        await this.active?.task;
        return true;
    }

    resolveApproval(requestId: string, decision: string) {
        const pending = this.approvals.get(requestId);
        if (!pending) return false;
        if (!["allowed-once", "rejected"].includes(decision)) throw new Error("DSH 审批决定无效");
        pending.resolve(decision as ApprovalOutcome);
        return true;
    }

    async openSettings() {
        await this.start();
        const address = await this.owned.start();
        const url = new URL(address.url);
        url.searchParams.set("token", address.token);
        await (this.options.openExternal || open)(url.href);
    }

    async listSkills(options: { sessionId?: string; forceReload?: boolean } = {}) {
        await this.start();
        if (options.forceReload) await this.owned.request("skills.refresh");
        let id = options.sessionId || this.catalogSessionId;
        if (!id) {
            id = this.catalogSessionId = (await this.newThread()).thread.id;
            unwrapDsh(await this.remote.workspace.archiveSession({ sessionId: SessionId(id) }));
        }
        await this.session(id);
        return unwrapDsh(await this.remote.skills.list({ sessionId: SessionId(id) }));
    }

    /** Named official RPC surface used by the skills coordinator, with no generic credential access. */
    async rpc(method: string, params: Record<string, unknown> = {}) {
        if (method === "skills.list") return this.listSkills(params);
        if (method === "session.read") return this.readThread(text(params.sessionId));
        throw new Error("不支持的 DSH 业务请求");
    }

    async generateSkillDraft(input: DshDraftInput): Promise<string> {
        input.signal?.throwIfAborted();
        await this.start();
        const source = input.source === "conversation" ? (await this.readThread(input.threadId || "")).messages.filter((item) => item.role === "user" || item.role === "assistant").map((item) => ({ role: item.role, text: redactSkillSourceText(item.text) })) : undefined;
        input.signal?.throwIfAborted();
        const selection = input.model || input.provider || input.effort ? this.modelSelection(unwrapDsh(await this.remote.session.modelCatalog()), input) : undefined;
        const created = record(await this.owned.request("draft.create", { ...(selection ? { selection } : {}) }));
        const id = text(created.sessionId);
        this.drafts.add(id);
        let cancellation: Promise<unknown> | undefined;
        const cancel = () => { cancellation = this.owned.request("session.quiesce", { sessionId: id, cancel: true }); void cancellation.catch(() => undefined); };
        input.signal?.addEventListener("abort", cancel, { once: true });
        try {
            input.signal?.throwIfAborted();
            const session = await this.session(id);
            const prompt = [input.prompt, source ? `\n原生对话文本：\n${JSON.stringify(source)}` : "", input.outputSchema ? `\noutputSchema：\n${JSON.stringify(input.outputSchema)}` : ""].join("\n");
            unwrapDsh(await this.remote.session.prompt({ sessionId: SessionId(id), requestId: crypto.randomUUID() as SessionRequestId, mode: "queue", content: [{ type: "text", text: prompt }] }, input.signal));
            const result = record(await this.owned.request("session.quiesce", { sessionId: id }));
            if (typeof result.seq === "number") await session.through(result.seq - 1);
            input.signal?.throwIfAborted();
            const response = session.history.messages().filter((message) => message.role === "assistant").at(-1)?.text;
            if (!response) throw new Error("DSH 未返回 Skill 草稿文本");
            return response;
        } finally {
            input.signal?.removeEventListener("abort", cancel);
            const failures: unknown[] = [];
            const settle = async (operation: () => unknown) => { try { await operation(); } catch (error) { failures.push(error); } };
            await settle(() => cancellation);
            await settle(() => this.owned.request("draft.dispose", { sessionId: id }));
            await settle(() => this.remote.workspace.archiveSession({ sessionId: SessionId(id) }).then(unwrapDsh));
            await settle(() => this.sessions.get(id)?.close());
            this.sessions.delete(id);
            this.drafts.delete(id);
            if (failures.length) throw new AggregateError(failures, "DSH 草稿会话释放失败");
        }
    }

    close() {
        return this.closing ??= (async () => {
            this.closed = true;
            const failures: unknown[] = [];
            const settle = async (operation: () => unknown) => { try { await operation(); } catch (error) { failures.push(error); } };
            for (const request of [...this.approvals.values()]) request.resolve("cancelled");
            if (this.active) await settle(() => this.interrupt(this.active!.threadId));
            const sessions = await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
            for (const result of sessions) if (result.status === "rejected") failures.push(result.reason);
            await settle(() => this.connection?.close());
            await settle(() => this.owned.close());
            if (failures.length) throw new AggregateError(failures, "DSH 资源释放失败");
        })();
    }
}
