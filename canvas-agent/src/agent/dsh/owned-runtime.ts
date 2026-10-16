import { fork, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAgentLogWriter, redactAgentLog } from "../../utils/agent-runtime.js";
import type { AgentEmit } from "../types.js";
import type { DshProfile } from "./profile-runtime.js";

export type DshAddress = { url: string; token: string };
export type OwnedRuntimeOptions = { workspacePath: string; runtimeId: string; config: { url: string; token: string; dsh?: { home?: string; profile?: DshProfile } }; emit: AgentEmit; environment?: NodeJS.ProcessEnv };

/** Owns exactly one child generation; IPC carries the ephemeral loopback credential. */
export class OwnedDshRuntime {
    private child?: ChildProcess;
    private opening?: Promise<DshAddress>;
    private exit?: Promise<void>;
    private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
    private stopped = false;

    constructor(private readonly options: OwnedRuntimeOptions) {}
    get isStopped() { return this.stopped; }

    start(): Promise<DshAddress> {
        if (this.stopped) return Promise.reject(new Error("DSH 运行时已关闭，请重新连接"));
        if (this.opening) return this.opening;
        const source = import.meta.url.endsWith(".ts");
        const entry = fileURLToPath(new URL(source ? "./launcher.ts" : "./launcher.js", import.meta.url));
        const mcpEntry = fileURLToPath(new URL(source ? "../../index.ts" : "../../index.js", import.meta.url));
        const { options } = this;
        const child = this.child = fork(entry, [], {
            cwd: options.workspacePath,
            execArgv: source ? ["--import", import.meta.resolve("tsx/esm")] : [],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            windowsHide: true,
            env: { ...(options.environment || process.env), ...(options.config.dsh?.home ? { DSH_HOME: options.config.dsh.home } : {}), DSH_TELEMETRY_DISABLED: "1", CANVAS_AGENT_DSH_PROFILE: options.config.dsh?.profile ?? "web", CANVAS_AGENT_ENGINE_ID: "dsh", CANVAS_AGENT_RUNTIME_ID: options.runtimeId, CANVAS_AGENT_URL: options.config.url, CANVAS_AGENT_TOKEN: options.config.token, CANVAS_AGENT_MCP_ENTRY: mcpEntry },
        });
        const logs = createAgentLogWriter((text) => options.emit("agent_log", { text, engineId: "dsh", runtimeId: options.runtimeId }));
        child.stdout?.on("data", (value: Buffer) => logs.write(value.toString()));
        child.stderr?.on("data", (value: Buffer) => logs.write(value.toString()));
        let rejectStart: (reason: Error) => void = () => undefined;
        this.opening = new Promise((resolve, reject) => {
            rejectStart = reject;
            child.on("message", (message: { type: string; url?: string; token?: string; id?: string; value?: unknown; error?: string }) => {
                if (this.child !== child) return;
                if (message.type === "ready" && message.url && message.token) {
                    const url = new URL(message.url);
                    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return reject(new Error("DSH 未绑定独立的本机端口"));
                    resolve({ url: url.origin, token: message.token });
                } else if (message.type === "failed") reject(new Error(redactAgentLog(message.error || "DSH 启动失败")));
                else if (message.type === "reply" && message.id) {
                    const waiter = this.pending.get(message.id);
                    this.pending.delete(message.id);
                    if (message.error) waiter?.reject(new Error(redactAgentLog(message.error)));
                    else waiter?.resolve(message.value);
                }
            });
            child.once("error", reject);
        });
        this.exit = new Promise((resolve) => child.once("exit", (code, signal) => {
            this.stopped = true;
            logs.flush();
            const error = new Error(`DSH 子进程已退出 (${code ?? signal ?? "unknown"})`);
            rejectStart(error);
            for (const waiter of this.pending.values()) waiter.reject(error);
            this.pending.clear();
            options.emit("dsh_event", { type: "runtime.exited", engineId: "dsh", runtimeId: options.runtimeId, code, signal });
            resolve();
        }));
        return this.opening;
    }

    async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        await this.start();
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.child!.send({ id, method, params }, (error) => {
                if (error) { this.pending.delete(id); reject(error); }
            });
        });
    }

    async close() {
        if (!this.child) { this.stopped = true; return; }
        await this.opening?.catch(() => undefined);
        if (!this.stopped && this.child.connected) this.child.send({ id: crypto.randomUUID(), method: "shutdown" });
        await this.exit;
    }
}
