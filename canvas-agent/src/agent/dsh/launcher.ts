import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";
import { SessionId } from "@deepseek-ai/dsh-session";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { toolNames } from "../../canvas/schemas.js";
import { installDraftIsolation } from "./draft-guard.js";
import { canvasToolGuard, runtimeTreeIncludes } from "./admission.js";
import { createDshOverlay } from "./overlay.js";
import { startDshWebHost } from "./profile-runtime.js";

// This entry is a private owned child. It never reads or prints the launch token.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "infinite-canvas-dsh-"));
const drafts = new Map<string, AgentHandle>();
let runtime: Awaited<ReturnType<typeof startDshWebHost>> | undefined;
let invalidateSkills: (() => void) | undefined;
let admittedRoot: string | undefined;

async function stop() {
    try { await runtime?.shutdown.shutdown(0); }
    finally {
        await fs.rm(temporary, { recursive: true, force: true });
        if (process.connected) process.disconnect();
    }
}

process.on("message", async (message: { id: string; method: string; params?: Record<string, unknown> }) => {
    try {
        const ctx = runtime?.ctx;
        if (!ctx) throw new Error("DSH 尚未启动");
        let value: unknown;
        const sessionId = String(message.params?.sessionId || "");
        if (message.method === "shutdown") { await stop(); return; }
        if (message.method === "draft.create") {
            const id = SessionId(crypto.randomUUID());
            const selection = message.params?.selection as { provider: string; model: string; reasoningEffort?: string } | undefined || ctx.agentDefaultModel.currentSelection();
            const handle = await ctx.agents.create({
                sessionId: id,
                meta: { cwd: process.cwd() },
                agentOptions: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) } : {}) },
                setup: installDraftIsolation,
            });
            drafts.set(id, handle);
            value = { sessionId: id };
        } else if (message.method === "draft.dispose") {
            await drafts.get(sessionId)?.dispose();
            drafts.delete(sessionId);
        } else if (message.method === "skills.refresh") {
            invalidateSkills?.();
        } else if (message.method === "approval.owner") {
            value = runtimeTreeIncludes(ctx.agents, String(message.params?.rootSessionId || ""), ctx.agents.get(SessionId(sessionId)));
        } else if (message.method === "session.resume") {
            const result = await ctx.sessionController.resolveAgent(SessionId(sessionId));
            if ("error" in result) throw result.error;
            value = { sessionId: result.agent.id };
        } else if (message.method === "turn.bind") {
            if (!ctx.agents.get(SessionId(sessionId))) throw new Error("DSH 前景会话尚未激活");
            if (admittedRoot && admittedRoot !== sessionId) throw new Error("DSH 已绑定其他前景任务");
            admittedRoot = sessionId;
        } else if (message.method === "turn.release") {
            if (admittedRoot === sessionId) admittedRoot = undefined;
        } else if (message.method === "session.quiesce") {
            const agent = ctx.agents.get(SessionId(sessionId));
            if (agent) {
                if (message.params?.cancel) {
                    agent.cancel({ kind: "user" });
                    const interruptChildren = async () => {
                        for (const child of await ctx.subagents.listDescendants(agent.id)) {
                            if (child.kind === "child") ctx.subagents.interrupt(child.id, { kind: "ancestor", agent });
                        }
                    };
                    await interruptChildren();
                    await agent.whenIdle();
                    await interruptChildren();
                }
                do { await agent.whenIdle(); } while (await ctx.subagents.waitForChildren(agent));
                await ctx.sessions.flush(agent.session);
                value = { seq: agent.session.seq };
            }
        } else throw new Error("未知的 DSH 子进程请求");
        process.send?.({ type: "reply", id: message.id, value });
    } catch (error) {
        process.send?.({ type: "reply", id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
});
process.on("disconnect", () => { void stop(); });

try {
    const entry = process.env.CANVAS_AGENT_MCP_ENTRY;
    if (!entry) throw new Error("缺少 Canvas MCP 入口");
    const patch = path.join(temporary, "canvas.patch.yml");
    await fs.writeFile(patch, createDshOverlay({ command: process.execPath, execArgv: process.execArgv, entry, cwd: process.cwd() }));
    const profile = process.env.CANVAS_AGENT_DSH_PROFILE ?? "web";
    if (profile !== "web" && profile !== "desktop") throw new Error("无效的 DSH 配置来源");
    runtime = await startDshWebHost({ environment: loadLayeredEnv("dsh"), profile, temporary, patch });
    const ctx = runtime.ctx;
    ctx.tools.guard(canvasToolGuard(ctx.agents, () => admittedRoot));
    ctx.skills.registerProvider((control) => {
        invalidateSkills = control.invalidate;
        return new FileSystemSkillProvider(ctx, control, { providerName: "infinite-canvas", includeDefaultRoots: false, customSkillDirs: [path.join(process.cwd(), ".dsh", "skills")] });
    });
    const schemas = ctx.tools.schemas();
    for (const name of toolNames) {
        const qualified = `mcp__infinite-canvas__${name}`;
        if (!ctx.tools.get(qualified) || !schemas.some((schema) => schema.name === qualified)) throw new Error(`DSH 未注册画布工具：${name}`);
    }
    const address = new URL(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
    const token = address.searchParams.get("token");
    if (!token) throw new Error("DSH 未提供连接令牌");
    process.send?.({ type: "ready", url: address.origin, token });
} catch (error) {
    // Error details may include profile values; only the parent redacts private diagnostics.
    process.send?.({ type: "failed", error: error instanceof Error ? error.message : String(error) });
    await stop();
    process.exitCode = 1;
}
