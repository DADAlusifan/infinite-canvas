import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CanvasSnapshot } from "../canvas/types.js";
import { logger } from "../utils/logger.js";
import { errorMessage, field } from "../utils/value.js";
import { SKILL_DRAFT_OUTPUT_SCHEMA, assertDraftHasNoSensitiveValues, canvasPrivateValues, skillDraftPrompt, skillDraftSchema, type AgentSkillDraft } from "../skills/draft.js";
export { assertDraftHasNoSensitiveValues, canvasSkillSource } from "../skills/draft.js";
export type { AgentSkillDraft } from "../skills/draft.js";
import { CodexAppClient, CodexReportedError } from "./codex-client.js";
import { codexEventHistory } from "./codex-event-history.js";
import { settledTurnIds, summarizeCodexThread, threadMessages } from "./codex-history.js";
import { messageMetadataStore } from "./message-metadata.js";
import type { CodexReasoningEffort, CodexSkillMetadata, CodexSkillSelector, CodexSkillsListEntry } from "./codex-protocol.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "./types.js";

type CodexRunOptions = { threadId?: string; cwd?: string; permissionMode?: AgentPermissionMode; model?: string; effort?: CodexReasoningEffort; skill?: CodexSkillSelector; messageText?: string; appEmit?: AgentEmit; onStart?: () => void; onThread?: (threadId: string) => void; onTurn?: (turnId: string) => void; onFinish?: () => void };
type CodexSkillDraftInput = { model?: string; effort?: CodexReasoningEffort } & ({ source: "conversation"; threadId: string } | { source: "canvas"; snapshot: CanvasSnapshot });

export class CodexSkillLookupError extends Error {
    override name = "CodexSkillLookupError";
    constructor(message: string, readonly statusCode: 400 | 404 | 409) {
        super(message);
    }
}

let codexQueue: Promise<unknown> = Promise.resolve();
let codexApp: CodexAppClient | null = null;
let codexAppStart: Promise<CodexAppClient> | null = null;
/** 仅表示最近主动加载/选择的线程；运行中的 turn 身份由 CodexAppClient 自己维护。 */
let loadedThreadId = "";

export { summarizeCodexThread } from "./codex-history.js";

/** 将 Codex turn 加入串行队列并等待执行完成。 */
export async function runCodexTurn(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[] = [], options: CodexRunOptions = {}) {
    if (!prompt.trim()) return;
    codexQueue = codexQueue.catch(() => undefined).then(() => runCodexTurnNow(prompt, lifecycleEmit, attachments, options));
    await codexQueue;
}

/** 从当前对话或指定网页画布生成可编辑草稿，不写入 Skill 文件。 */
export async function generateCodexSkillDraft(emit: AgentEmit, cwd: string, input: CodexSkillDraftInput): Promise<AgentSkillDraft> {
    const queued = codexQueue.catch(() => undefined).then(() => generateCodexSkillDraftNow(emit, cwd, input));
    codexQueue = queued;
    return await queued;
}

/** 中断当前线程正在执行的 Codex turn。 */
export async function interruptCodexTurn(threadId?: string) {
    if (!codexApp) return false;
    return await codexApp.interruptCurrentTurn(threadId);
}

/** 回复当前 app-server 的待处理权限请求。 */
export async function resolveCodexApproval(requestId: string, decision: string) {
    return Boolean(codexApp?.resolveApproval(requestId, decision));
}

/** 创建新的 Codex 线程并记录当前线程 ID。 */
export async function startCodexThread(emit: AgentEmit, cwd?: string, permissionMode: AgentPermissionMode = "request", preheat = false) {
    const app = await getCodexApp(emit);
    const thread = await app.startThread(cwd, permissionMode, preheat);
    loadedThreadId = String(field(thread, "id") || "");
    return thread;
}

/** 恢复指定 Codex 线程并返回聊天历史。 */
export async function resumeCodexThread(emit: AgentEmit, threadId: string, cwd?: string, permissionMode: AgentPermissionMode = "request", preheat = false) {
    const app = await getCodexApp(emit);
    const thread = await resumeLoadedThread(app, threadId, cwd, permissionMode, true, preheat);
    const history = await loadCodexHistory(emit, threadId, cwd);
    const supplementalItems = await codexEventHistory.readThread(threadId);
    const messages = await mergeMessageMetadata(threadId, threadMessages(history.thread, app.planUpdates(threadId), supplementalItems));
    return { thread, messages, settledTurnIds: settledTurnIds(history.thread, supplementalItems), historyReady: history.historyReady };
}

/** 查询当前工作空间中的 Codex 线程。 */
export async function listCodexThreads(emit: AgentEmit, options: { cwd: string; searchTerm?: string; limit?: number }) {
    const app = await getCodexApp(emit);
    const result = await app.listThreads({
        limit: options.limit || 40,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "appServer", "exec"],
        cwd: options.cwd,
        ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
    });
    const data = Array.isArray(field(result, "data")) ? (field(result, "data") as unknown[]).map(summarizeCodexThread).filter((thread) => threadInWorkspace(thread, options.cwd)) : [];
    return { data, nextCursor: field(result, "nextCursor") || null, backwardsCursor: field(result, "backwardsCursor") || null };
}

/** 查询当前账号可用于新任务的 Codex 模型。 */
export async function listCodexModels(emit: AgentEmit) {
    return await (await getCodexApp(emit)).listModels();
}

/** 查询当前工作空间的原生 Skill 列表。 */
export async function listCodexSkills(emit: AgentEmit, cwd: string, forceReload = false): Promise<CodexSkillsListEntry> {
    const result = await (await getCodexApp(emit)).listSkills(cwd, forceReload);
    return result.data.find((entry) => samePath(entry.cwd, cwd)) || { cwd, skills: [], errors: [] };
}

/** 从原生 Skill 列表中解析并校验浏览器提交的选择器。 */
export async function resolveCodexSkill(emit: AgentEmit, cwd: string, selector: CodexSkillSelector, requireEnabled = false): Promise<CodexSkillMetadata> {
    const name = String(selector?.name || "");
    const requestedPath = String(selector?.path || "");
    if (!name || !requestedPath || !path.isAbsolute(requestedPath)) throw new CodexSkillLookupError("Skill 选择无效", 400);
    const { skills } = await listCodexSkills(emit, cwd, true);
    const skill = skills.find((item) => item.name === name && samePath(item.path, requestedPath));
    if (!skill) throw new CodexSkillLookupError("找不到指定 Skill，请刷新列表后重试", 404);
    if (requireEnabled && !skill.enabled) throw new CodexSkillLookupError("该 Skill 已停用，请先启用后再使用", 409);
    return skill;
}

/** 修改经过原生列表校验的 Skill 启用状态。 */
export async function configureCodexSkill(emit: AgentEmit, cwd: string, selector: CodexSkillSelector, enabled: boolean) {
    const skill = await resolveCodexSkill(emit, cwd, selector);
    const result = await (await getCodexApp(emit)).setSkillEnabled(skill.path, enabled);
    return { ...result, skill: { ...skill, enabled: result.effectiveEnabled } };
}

/** 读取指定 Codex 线程及其聊天历史。 */
export async function readCodexThread(emit: AgentEmit, threadId: string, cwd?: string) {
    const app = await getCodexApp(emit);
    const history = await loadCodexHistory(emit, threadId, cwd);
    const supplementalItems = await codexEventHistory.readThread(threadId);
    const messages = await mergeMessageMetadata(threadId, threadMessages(history.thread, app.planUpdates(threadId), supplementalItems));
    return { thread: summarizeCodexThread(history.thread), messages, settledTurnIds: settledTurnIds(history.thread, supplementalItems), historyReady: history.historyReady };
}

/** 归档指定 Codex 线程。 */
export async function archiveCodexThread(emit: AgentEmit, threadId: string, cwd?: string) {
    const app = await getCodexApp(emit);
    try {
        await loadCodexThread(emit, threadId, cwd, false);
    } catch (error) {
        if (!isRecoverableThreadError(error)) throw error;
        await resumeLoadedThread(app, threadId, cwd, "request", false);
    }
    await app.archiveThread(threadId);
    app.clearPlanUpdates(threadId);
    await codexEventHistory.removeThread(threadId);
    await messageMetadataStore.removeThread(threadId).catch((error) => logger.warn("Failed to remove archived thread message metadata", { threadId, error }));
    if (loadedThreadId === threadId) loadedThreadId = "";
}

async function mergeMessageMetadata<T extends { role: string; threadId: string; turnId: string }>(threadId: string, messages: T[]) {
    try {
        return await messageMetadataStore.mergeThread(threadId, messages);
    } catch (error) {
        logger.warn("Failed to read thread message metadata", { threadId, error });
        return messages;
    }
}

/** 判断线程异常是否允许自动新建线程后重试。 */
export function isRecoverableThreadError(error: unknown) {
    return /thread not loaded|no rollout found/i.test(errorMessage(error));
}

/** 执行一次 Codex turn，并负责附件临时文件和线程恢复。 */
async function runCodexTurnNow(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[], options: CodexRunOptions) {
    let files: string[] = [];
    try {
        options.onStart?.();
        files = await writeAttachmentFiles(attachments);
        const app = await getCodexApp(options.appEmit || lifecycleEmit);
        let threadId = await ensureCodexThread(app, options, lifecycleEmit);
        options.onThread?.(threadId);
        try {
            await app.startTurn(threadId, prompt, files, options.permissionMode || "request", options.model, options.effort, options.onTurn, options.skill, options.messageText);
        } catch (error) {
            if (!isRecoverableThreadError(error)) throw error;
            lifecycleEmit("agent_log", { text: `Codex thread unavailable, starting a new thread: ${errorMessage(error)}` });
            loadedThreadId = "";
            threadId = await ensureCodexThread(app, { cwd: options.cwd }, lifecycleEmit);
            options.onThread?.(threadId);
            await app.startTurn(threadId, prompt, files, options.permissionMode || "request", options.model, options.effort, options.onTurn, options.skill, options.messageText);
        }
    } catch (error) {
        logger.error("Codex turn failed", error);
        if (!(error instanceof CodexReportedError)) lifecycleEmit("agent_error", { message: errorMessage(error) });
    } finally {
        options.onFinish?.();
        await Promise.all(files.map((file) => fs.unlink(file).catch(() => undefined)));
    }
}

/** 恢复请求线程或创建新的 Codex 线程。 */
async function ensureCodexThread(app: CodexAppClient, options: CodexRunOptions, emit: AgentEmit) {
    if (options.threadId) {
        if (options.threadId === loadedThreadId) return loadedThreadId;
        try {
            await resumeLoadedThread(app, options.threadId, options.cwd, options.permissionMode || "request", true);
            return loadedThreadId;
        } catch (error) {
            if (!isRecoverableThreadError(error)) throw error;
            emit("agent_log", { text: `Codex thread unavailable, starting a new thread: ${errorMessage(error)}` });
            loadedThreadId = "";
        }
    }
    if (!loadedThreadId) {
        const thread = await app.startThread(options.cwd, options.permissionMode || "request");
        loadedThreadId = String(field(thread, "id") || "");
    }
    return loadedThreadId;
}

/** 从 app-server 读取线程并校验工作空间。 */
async function loadCodexThread(emit: AgentEmit, threadId: string, cwd: string | undefined, includeTurns: boolean) {
    const app = await getCodexApp(emit);
    const result = await app.readThread(threadId, includeTurns);
    const thread = field(result, "thread") || {};
    assertThreadWorkspace(thread, cwd);
    return thread;
}

async function generateCodexSkillDraftNow(emit: AgentEmit, cwd: string, input: CodexSkillDraftInput) {
    const app = await getCodexApp(emit);
    let threadId = "";
    try {
        const thread = input.source === "conversation" ? await app.forkSkillDraftThread(input.threadId, cwd) : await app.startSkillDraftThread(cwd);
        threadId = String(field(thread, "id") || "");
        const raw = await app.generateSkillDraft(threadId, skillDraftPrompt(input), SKILL_DRAFT_OUTPUT_SCHEMA, input.model, input.effort);
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            throw new Error("Codex 返回的 Skill 草稿不是有效 JSON");
        }
        const parsed = skillDraftSchema.safeParse(value);
        if (!parsed.success) throw new Error("Codex 返回的 Skill 草稿格式不正确");
        assertDraftHasNoSensitiveValues(parsed.data, input.source === "canvas" ? canvasPrivateValues(input.snapshot) : []);
        return parsed.data;
    } finally {
        if (threadId) await app.closeSkillDraftThread(threadId).catch((error) => logger.warn("Failed to release Skill draft thread", { threadId, error }));
    }
}

/** 读取线程历史，并显式标记 Codex 是否已经物化 turns。 */
async function loadCodexHistory(emit: AgentEmit, threadId: string, cwd?: string) {
    try {
        return { thread: await loadCodexThread(emit, threadId, cwd, true), historyReady: true };
    } catch (error) {
        if (/not materialized yet.*includeTurns/i.test(errorMessage(error))) return { thread: await loadCodexThread(emit, threadId, cwd, false), historyReady: false };
        if (!isRecoverableThreadError(error)) throw error;
        const app = await getCodexApp(emit);
        const thread = await resumeLoadedThread(app, threadId, cwd, "request", false);
        try {
            return { thread: await loadCodexThread(emit, threadId, cwd, true), historyReady: true };
        } catch (historyError) {
            if (/not materialized yet.*includeTurns/i.test(errorMessage(historyError))) return { thread, historyReady: false };
            throw historyError;
        }
    }
}

/** 恢复线程并统一校验工作空间与进程内活动线程。 */
async function resumeLoadedThread(app: CodexAppClient, threadId: string, cwd?: string, permissionMode: AgentPermissionMode = "request", updateLoaded = true, preheat = false) {
    const thread = await app.resumeThread(threadId, cwd, permissionMode, preheat);
    assertThreadWorkspace(thread, cwd);
    if (updateLoaded) loadedThreadId = String(field(thread, "id") || threadId);
    return thread;
}

/** 获取已启动的 Codex app-server 客户端。 */
async function getCodexApp(emit: AgentEmit) {
    if (codexApp) return codexApp;
    codexAppStart ||= CodexAppClient.start(emit, () => {
        codexApp = null;
        loadedThreadId = "";
    });
    try {
        codexApp = await codexAppStart;
        return codexApp;
    } finally {
        codexAppStart = null;
    }
}

/** 校验线程是否属于指定工作空间。 */
function assertThreadWorkspace(thread: unknown, cwd?: string) {
    if (!cwd || threadInWorkspace(thread, cwd)) return;
    throw new Error("该 Codex 会话不属于当前画布工作空间");
}

/** 判断线程工作目录是否与当前工作空间一致。 */
function threadInWorkspace(thread: unknown, cwd: string) {
    const threadCwd = String(field(thread, "cwd") || "");
    return Boolean(threadCwd && samePath(threadCwd, cwd));
}

/** 比较跨平台绝对路径；Windows 路径不区分大小写。 */
function samePath(left: string, right: string) {
    const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    return normalize(left) === normalize(right);
}

/** 将图片附件写入临时文件供 Codex 读取。 */
async function writeAttachmentFiles(attachments: AgentAttachment[]) {
    return await Promise.all(attachments.filter((item) => item.dataUrl?.startsWith("data:image/")).map(writeAttachmentFile));
}

/** 将单个 Data URL 图片附件写入临时文件。 */
async function writeAttachmentFile(item: AgentAttachment) {
    const [, meta = "", data = ""] = item.dataUrl?.match(/^data:([^;]+);base64,(.+)$/) || [];
    if (!data) throw new Error(`图片附件无效：${item.name || "未命名图片"}`);
    const file = path.join(os.tmpdir(), `infinite-canvas-${Date.now()}-${Math.random().toString(16).slice(2)}.${imageExt(meta || item.type)}`);
    await fs.writeFile(file, Buffer.from(data, "base64"));
    return file;
}

/** 根据图片 MIME 类型返回临时文件扩展名。 */
function imageExt(type = "") {
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    return "jpg";
}
