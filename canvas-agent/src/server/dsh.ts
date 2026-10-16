import path from "node:path";
import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import type { DshAgent } from "../agent/dsh/index.js";
import type { AgentEngineDescriptor, AgentScope, DshConfigProfile } from "../agent/engine.js";
import type { AgentAttachment } from "../agent/types.js";
import { MessageMetadataStore } from "../agent/message-metadata.js";
import { CanvasSession } from "../canvas/session.js";
import { CONFIG_DIR, ensureSiteWorkspace, saveConfig, type CanvasAgentConfig } from "../config.js";
import { DshSkillService, withDshSkill } from "../skills/dsh.js";
import { logger } from "../utils/logger.js";

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => handler(req, res)).catch(next);
};
const text = (value: unknown) => typeof value === "string" ? value : "";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const DSH_ENGINE: AgentEngineDescriptor = {
    id: "dsh", name: "DeepSeek Harness",
    capabilities: { permissions: [], skills: true, attachments: true, manageSettings: true },
};

type ControllerOptions = {
    config: CanvasAgentConfig;
    session: CanvasSession;
    persist?: (config: CanvasAgentConfig) => void;
    metadata?: MessageMetadataStore;
    createRuntime?: (emit: (type: string, payload: unknown) => void) => Promise<DshAgent>;
    descriptorsChanged?: () => void;
};

/** The app-facing coordinator owns the active webpage and mutation lock; DSH owns its native sessions. */
export class DshController {
    private runtime?: DshAgent;
    private starting?: Promise<DshAgent>;
    private skills?: DshSkillService;
    private draft?: AbortController;
    private descriptorValue = DSH_ENGINE;
    private readonly metadata: MessageMetadataStore;
    private readonly persist: (config: CanvasAgentConfig) => void;

    constructor(private readonly options: ControllerOptions) {
        this.persist = options.persist || saveConfig;
        this.metadata = options.metadata || new MessageMetadataStore(path.join(CONFIG_DIR, "dsh-message-metadata"));
    }

    descriptor() { return { ...this.descriptorValue, configProfile: this.options.config.dsh?.profile || "web" }; }
    private refreshDescriptor(runtime: DshAgent) {
        if (runtime !== this.runtime) return;
        const capabilities = record(runtime.capabilities);
        if (!Array.isArray(capabilities.permissions)) return;
        this.descriptorValue = { ...DSH_ENGINE, capabilities: {
            ...DSH_ENGINE.capabilities,
            permissions: capabilities.permissions as AgentEngineDescriptor["capabilities"]["permissions"],
            defaultPermissionMode: text(capabilities.defaultPermissionMode) || undefined,
        } };
        this.options.descriptorsChanged?.();
    }
    workspace() {
        return { ...ensureSiteWorkspace(this.options.config), activeThreadId: this.options.config.dsh?.activeThreadId };
    }

    private async agent() {
        if (this.runtime) return this.runtime;
        if (this.starting) return this.starting;
        const scope: AgentScope = { engineId: "dsh", runtimeId: this.options.session.runtimeFor("dsh") };
        this.starting = (async () => {
            const emit = (type: string, payload: unknown) => this.emit(type, { ...record(payload), ...scope });
            const runtime = this.options.createRuntime
                ? await this.options.createRuntime(emit)
                : new (await import("../agent/dsh/index.js")).DshAgent({
                    workspacePath: this.workspace().workspacePath,
                    config: this.options.config,
                    runtimeId: scope.runtimeId,
                    emit,
                });
            this.runtime = runtime;
            this.skills = new DshSkillService(this.workspace().workspacePath, runtime);
            return runtime;
        })();
        try { return await this.starting; }
        finally { this.starting = undefined; }
    }

    private snapshot() {
        const session = this.options.session;
        return { ok: true, ...session.engineSnapshot, engine: this.descriptor(), workspace: this.workspace(), conversation: session.conversationStateSnapshot };
    }

    private publishProfile() {
        this.options.descriptorsChanged?.();
        this.options.session.emitAll("engine_changed", this.snapshot());
    }

    private async changeProfile(profile: DshConfigProfile, clientId: string) {
        if (profile === this.descriptor().configProfile) return;
        if (this.starting) await this.starting;
        await this.runtime?.close();
        this.runtime = undefined;
        this.skills = undefined;
        const config = this.options.config;
        const previous = config.dsh;
        config.dsh = { ...previous, profile, activeThreadId: undefined };
        try { this.persist(config); }
        catch (error) { config.dsh = previous; throw error; }
        this.descriptorValue = DSH_ENGINE;
        this.options.session.restartDshRuntime();
        this.publishProfile();
        await this.prepare(clientId);
    }

    private emit(type: string, payload: Record<string, unknown>) {
        const session = this.options.session;
        if (!session.matchesScope(payload)) return;
        const data = { ...payload, ...session.eventScope };
        const threadId = text(payload.threadId) || text(payload.sessionId) || data.threadId;
        const turnId = text(payload.turnId) || data.turnId;
        if (threadId && threadId !== session.agentThreadId) return;
        if (session.agentBusy && session.runStateSnapshot.turnId && turnId && turnId !== session.runStateSnapshot.turnId) return;
        const event = { ...data, ...payload, threadId, turnId };
        session.trackEvent(type, event);
        threadId ? session.emitThread(type, threadId, event) : session.emitAll(type, event);
    }

    private setActiveThread(threadId: string, clientId = "") {
        this.options.config.dsh = { ...this.options.config.dsh, activeThreadId: threadId || undefined };
        this.persist(this.options.config);
        const session = this.options.session;
        session.setRunState({ threadId, turnId: "" });
        session.emitAll("workspace_changed", { activeThreadId: threadId, sourceClientId: clientId, conversation: session.conversationStateSnapshot });
    }

    private async history(value: Record<string, unknown>, threadId: string) {
        const messages = Array.isArray(value.messages) ? value.messages : [];
        return { ...value, messages: await this.metadata.mergeThread(threadId, messages as Array<{ role: string; threadId: string; turnId: string }>) };
    }

    async prepare(clientId = "", options: Record<string, unknown> = {}, fresh = false) {
        const session = this.options.session;
        const current = fresh ? "" : this.workspace().activeThreadId || "";
        session.beginConversation({ threadId: current, sourceClientId: clientId });
        session.emitAll("agent_bootstrap", { type: "dsh.preparing", phase: "preheat" });
        try {
            const runtime = await this.agent();
            await runtime.start();
            this.refreshDescriptor(runtime);
            const result = current
                ? await runtime.resumeThread(current)
                : await runtime.newThread(options);
            const value = record(result);
            const thread = record(value.thread || value);
            const threadId = text(thread.id) || text(thread.sessionId);
            if (!threadId) throw new Error("DSH 未返回可用的会话标识");
            session.completeConversationMcpInventory([{ name: "infinite-canvas", authStatus: "loggedIn" }]);
            session.completeConversationPreparation(threadId);
            this.setActiveThread(threadId, clientId);
            return { ...await this.history(value, threadId), thread, workspace: this.workspace(), conversation: session.conversationStateSnapshot };
        } catch (error) {
            session.failConversationPreparation(error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    private mutation(handler: Handler) {
        return route(async (req, res) => {
            const session = this.options.session;
            if (!session.beginMutation()) return res.status(409).json({ ok: false, code: "CONVERSATION_BUSY", error: "Agent 正在运行、等待审批或切换会话", state: session.conversationStateSnapshot });
            try { return await handler(req, res); }
            finally { session.endMutation(); }
        });
    }

    register(app: Express) {
        app.post("/agent/engines/dsh/profile", route(async (req, res) => {
            const session = this.options.session;
            const profile = req.body?.profile;
            const clientId = text(req.body?.clientId);
            if (profile !== "web" && profile !== "desktop") return res.status(400).json({ ok: false, error: "DSH 配置来源只能为 Web 或 Desktop" });
            if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起切换的页面已断开" });
            if (session.scope.engineId !== "dsh" || req.body?.expectedEngineId !== "dsh" || !req.body?.runtimeId || !session.matchesScope({ engineId: req.body.expectedEngineId, runtimeId: req.body.runtimeId })) return res.status(409).json({ ok: false, code: "ENGINE_STALE", error: "Agent 已在其他页面切换", ...session.engineSnapshot });
            if (!session.beginMutation()) return res.status(409).json({ ok: false, code: "CONVERSATION_BUSY", error: "请等待 Agent 任务、审批或初始化完成" });
            try { await this.changeProfile(profile, clientId); }
            catch (error) {
                session.failConversationPreparation(error instanceof Error ? error.message : String(error));
                throw error;
            } finally {
                session.endMutation();
                this.publishProfile();
            }
            res.json(this.snapshot());
        }));
        app.get("/agent/dsh/workspace", (_req, res) => res.json({ ok: true, workspace: this.workspace(), conversation: this.options.session.conversationStateSnapshot }));
        app.get("/agent/dsh/models", route(async (_req, res) => {
            const runtime = await this.agent();
            const result = await runtime.models();
            this.refreshDescriptor(runtime);
            res.json({ ok: true, ...record(result) });
        }));
        app.post("/agent/dsh/settings/open", route(async (_req, res) => {
            await (await this.agent()).openSettings();
            res.json({ ok: true });
        }));
        app.get("/agent/dsh/threads", route(async (req, res) => res.json({
            ok: true, workspace: this.workspace(), conversation: this.options.session.conversationStateSnapshot,
            ...record(await (await this.agent()).threads({ searchTerm: text(req.query.searchTerm) })),
        })));
        for (const action of ["new", "reset"]) app.post(`/agent/dsh/threads/${action}`, this.mutation(async (req, res) => {
            res.json({ ok: true, ...await this.prepare(text(req.body?.clientId), record(req.body), true) });
        }));
        app.get("/agent/dsh/threads/:threadId", route(async (req, res) => {
            const threadId = text(req.params.threadId);
            const result = await (await this.agent()).readThread(threadId);
            const value = record(result);
            res.json({ ok: true, ...await this.history(value, threadId), workspace: this.workspace(), conversation: this.options.session.conversationStateSnapshot });
        }));
        app.post("/agent/dsh/threads/:threadId/resume", this.mutation(async (req, res) => {
            const session = this.options.session;
            const threadId = text(req.params.threadId);
            session.beginConversation({ threadId, sourceClientId: text(req.body?.clientId) });
            try {
                const result = await (await this.agent()).resumeThread(threadId);
                session.completeConversationMcpInventory([{ name: "infinite-canvas", authStatus: "loggedIn" }]);
                session.completeConversationPreparation(threadId);
                this.setActiveThread(threadId, text(req.body?.clientId));
                res.json({ ok: true, ...await this.history(record(result), threadId), workspace: this.workspace(), conversation: session.conversationStateSnapshot });
            } catch (error) { session.failConversationPreparation(String(error)); throw error; }
        }));
        app.post("/agent/dsh/threads/:threadId/delete", this.mutation(async (req, res) => {
            const threadId = text(req.params.threadId);
            await (await this.agent()).archiveThread(threadId);
            await this.metadata.removeThread(threadId);
            if (this.workspace().activeThreadId === threadId) {
                this.options.session.activateConversation("");
                this.setActiveThread("");
            }
            res.json({ ok: true, workspace: this.workspace(), conversation: this.options.session.conversationStateSnapshot });
        }));
        app.post("/agent/dsh/history/ack", (req, res) => {
            this.options.session.acknowledgeHistory(text(req.body?.threadId), Array.isArray(req.body?.turnIds) ? req.body.turnIds.map(String) : []);
            res.json({ ok: true });
        });
        app.post("/agent/dsh/turn", this.mutation((req, res) => this.turn(req, res)));
        app.post("/agent/dsh/interrupt", route(async (req, res) => {
            if (this.draft) this.draft.abort(new Error("Skill 草稿已取消"));
            const ok = this.draft ? true : await (await this.agent()).interrupt(text(req.body?.threadId) || undefined);
            res.status(ok === false ? 409 : 200).json({ ok: ok !== false });
        }));
        app.post("/agent/dsh/approval", route(async (req, res) => {
            const ok = await (await this.agent()).resolveApproval(text(req.body?.requestId), text(req.body?.decision));
            res.status(ok === false ? 409 : 200).json({ ok: ok !== false });
        }));
        app.get("/agent/dsh/message-assets/:messageKey/:assetFile", route(async (req, res) => {
            const asset = await this.metadata.readAsset(text(req.params.messageKey), text(req.params.assetFile));
            if (!asset) return res.status(404).json({ ok: false, error: "message asset not found" });
            res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
            res.type(asset.contentType).send(asset.data);
        }));
        app.get("/agent/dsh/native-attachments/:threadId/:attachmentId", route(async (req, res) => {
            const value = await (await this.agent()).readAttachment(text(req.params.threadId), text(req.params.attachmentId));
            res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
            res.type(value.attachment.mediaType).send(Buffer.from(value.data, "base64"));
        }));
        this.registerSkills(app);
    }

    private async skillService() { await this.agent(); return this.skills!; }

    private registerSkills(app: Express) {
        app.get("/agent/dsh/skills", route(async (_req, res) => {
            const result = await (await this.skillService()).list(this.workspace().activeThreadId);
            res.json({ ok: true, data: result.skills, errors: result.errors });
        }));
        app.get("/agent/dsh/skills/:name", route(async (req, res) => res.json({ ok: true, data: await (await this.skillService()).get(text(req.params.name)) })));
        const changed = () => this.options.session.emitAll("skills_changed", { forceReload: true });
        app.post("/agent/dsh/skills", this.mutation(async (req, res) => {
            const data = await (await this.skillService()).create(req.body);
            changed(); res.status(201).json({ ok: true, data });
        }));
        app.post("/agent/dsh/skills/:name/enabled", this.mutation(async (req, res) => {
            if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ ok: false, error: "Skill 启用状态无效" });
            const data = await (await this.skillService()).setEnabled(text(req.params.name), req.body.enabled, text(req.body?.expectedRevision));
            changed(); res.json({ ok: true, data });
        }));
        app.post("/agent/dsh/skills/:name/delete", this.mutation(async (req, res) => {
            await (await this.skillService()).delete(text(req.params.name), text(req.body?.expectedRevision));
            changed(); res.json({ ok: true });
        }));
        app.post("/agent/dsh/skills/draft", this.mutation(async (req, res) => {
            const session = this.options.session;
            const clientId = text(req.body?.clientId);
            if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开" });
            const source = text(req.body?.source);
            if (source !== "canvas" && source !== "conversation") return res.status(400).json({ ok: false, error: "Skill 草稿来源无效" });
            const threadId = text(req.body?.threadId);
            if (source === "conversation" && (!threadId || threadId !== this.workspace().activeThreadId)) return res.status(409).json({ ok: false, error: "当前对话已切换，请刷新后重试" });
            const snapshot = source === "canvas" ? session.canvasStateForClient(clientId) : undefined;
            if (source === "canvas" && (!snapshot || (snapshot as Record<string, unknown>).hasCanvas === false)) return res.status(409).json({ ok: false, error: "当前页面没有可提炼的画布" });
            const controller = new AbortController();
            this.draft = controller;
            const previous = session.runStateSnapshot;
            session.setRunState({ busy: true });
            try {
                const data = await (await this.skillService()).generateDraft({ source, threadId, snapshot: snapshot || undefined, clientId, model: text(req.body?.model) || undefined, provider: text(req.body?.provider) || undefined, effort: text(req.body?.effort) || undefined, signal: controller.signal });
                controller.signal.throwIfAborted();
                if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开" });
                res.json({ ok: true, data });
            } finally { this.draft = undefined; session.setRunState(previous, { preserveReplay: true }); }
        }));
        app.post("/agent/dsh/skills/:name", this.mutation(async (req, res) => {
            const data = await (await this.skillService()).update(text(req.params.name), req.body);
            changed(); res.json({ ok: true, data });
        }));
    }

    private async turn(req: Request, res: Response) {
        const session = this.options.session;
        const body = record(req.body);
        const clientId = text(body.clientId);
        const threadId = text(body.threadId);
        const prompt = text(body.prompt);
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起任务的网页已断开" });
        const conversation = session.conversationStateSnapshot;
        if (!threadId || threadId !== this.workspace().activeThreadId || conversation.threadId !== threadId || body.conversationId !== conversation.conversationId || body.expectedRevision !== conversation.revision) return res.status(409).json({ ok: false, code: "CONVERSATION_STALE", error: "当前会话已切换，请同步后重试", state: conversation });
        if (!["ready", "warning"].includes(conversation.status)) return res.status(409).json({ ok: false, code: "CONVERSATION_NOT_READY", error: "DSH 会话尚未就绪", state: conversation });
        const runtime = await this.agent();
        const selectedSkill = body.skill ? await (await this.skillService()).resolve(body.skill as { name: string; path: string }, true, threadId) : undefined;
        const attachments = Array.isArray(body.attachments) ? body.attachments as AgentAttachment[] : [];
        const messageId = text(body.messageId) || crypto.randomUUID();
        const metadata = await this.metadata.recordPending(messageId, body.messageMetadata);
        await this.metadata.bindThread(messageId, threadId);
        const attachmentRefs = session.setTurnAttachments(clientId, attachments);
        const context = attachmentRefs.length ? `\n\n本轮可用图片附件：${JSON.stringify(attachmentRefs)}。放入画布前请调用 canvas_create_attachment_nodes。` : "";
        const requestPrompt = `${selectedSkill ? withDshSkill(prompt, selectedSkill.name) : prompt}${context}`;
        session.bindClient(clientId);
        session.markConversationRunning(threadId);
        session.setRunState({ busy: true, threadId, turnId: "" });
        const messageText = text(body.messageText) || prompt;
        session.emitThread("chat_message", threadId, { sourceClientId: clientId, message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...metadata } });
        let turnId = "";
        void Promise.resolve().then(() => runtime.runTurn(requestPrompt, attachments, {
            threadId, model: text(body.model) || undefined, provider: text(body.provider) || undefined, clientMessageId: messageId,
            effort: text(body.effort) || undefined, permissionMode: text(body.permissionMode) || undefined,
            onTurn: (nativeTurnId: string) => {
                turnId = nativeTurnId;
                session.setRunState({ turnId });
                void this.metadata.bindTurn(messageId, threadId, turnId).catch((error) => logger.warn("DSH message metadata save failed", { error }));
            },
        })).catch((error: unknown) => {
            session.emitThread("agent_error", threadId, { turnId, message: error instanceof Error ? error.message : String(error) });
        }).finally(() => {
            if (!turnId) void this.metadata.remove(messageId, threadId).catch((error) => logger.warn("DSH 未绑定消息清理失败", { error }));
            session.cancelPendingTools();
            session.clearTurnAttachments(clientId);
            session.releaseClient(clientId);
            session.setRunState({ busy: false, threadId, turnId });
            session.finishConversationRun(threadId);
        });
        res.json({ ok: true, threadId });
    }

    async close() { this.draft?.abort(new Error("Agent 服务正在退出")); await this.runtime?.close(); }
}
