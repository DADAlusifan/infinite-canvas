import { isAppendSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import type { SessionWireEvent } from "@deepseek-ai/dsh-api-session-controller/types";

export type DshItem = { id: string; role: string; text: string; engineId: "dsh"; runtimeId: string; threadId: string; turnId: string; itemId: string; createdAt: number; title?: string; detail?: Record<string, unknown>; clientMessageId?: string; attachments?: Array<{ id: string; name: string; type: string; size: number; width: number; height: number; url: string }>; native?: unknown };
export type DshEvent = { type: string; engineId: "dsh"; runtimeId: string; threadId: string; turnId: string; itemId?: string; item?: DshItem; removeItemId?: string; native?: unknown; [key: string]: unknown };
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const text = (value: unknown) => typeof value === "string" ? value : "";
export const blockText = (blocks: unknown, kind = "text") => list(blocks).filter((block) => record(block).type === kind).map((block) => text(record(block).text)).join("");

/** Native append-origin records are the transcript; replacement copies stay model-only. */
export class DshHistory {
    readonly events = new Map<number, SessionWireEvent>();
    currentTurn = "";
    constructor(readonly runtimeId: string, readonly threadId: string) {}

    scope(turnId = this.currentTurn): Omit<DshEvent, "type"> {
        return { engineId: "dsh", runtimeId: this.runtimeId, threadId: this.threadId, turnId };
    }

    item(itemId: string, role: string, value: string, turnId = this.currentTurn, time = Date.now(), extra: Partial<DshItem> = {}): DshItem {
        return { id: itemId, role, text: value, engineId: "dsh", runtimeId: this.runtimeId, threadId: this.threadId, turnId, itemId, createdAt: time, ...extra };
    }

    accept(event: SessionWireEvent): DshEvent[] {
        if (this.events.has(event.seq)) return [];
        this.events.set(event.seq, event);
        const data = record(event.data);
        if (typeof data.turn === "number") this.currentTurn = String(data.turn);
        const scope = this.scope();
        if (event.type === "turn/start") return [{ ...scope, type: "turn.started", native: event }];
        if (event.type === "turn/end") {
            const reason = record(data.reason);
            const interrupted = ["aborted", "interrupted", "forked"].includes(text(reason.kind));
            const failed = reason.kind !== "completed" && !interrupted;
            const message = reason.kind === "blocked" ? "DSH 任务被权限或策略阻断" : reason.kind === "max-tokens" ? "DSH 任务达到模型输出上限" : "DSH 任务未正常完成";
            return [{ ...scope, type: failed ? "turn.failed" : "turn.completed", status: interrupted ? "interrupted" : reason.kind, ...(failed ? { error: reason.error || { message } } : {}), native: event }];
        }
        if (event.type === "tool/call") {
            const id = text(data.callId);
            const item = this.item(id, "tool", text(data.name), undefined, event.time, { title: text(data.name), detail: { kind: "tool", status: "inProgress", input: data.arguments }, native: event });
            return [{ ...scope, type: "tool.started", itemId: id, item, native: event }];
        }
        if (!["user/message", "assistant/message", "tool/result"].includes(event.type) || !isAppendSurfaceEvent(event as unknown as SessionEvent)) {
            return [{ ...scope, type: "native.event", native: event }];
        }
        const message = event.type === "user/message" ? data : record(data.message);
        const id = event.type === "tool/result" ? text(message.toolCallId) : text(message.id);
        if (!id) throw new Error(`DSH 消息缺少原生标识 (${event.seq})`);
        const source = record(message.source);
        if (event.type === "user/message" && !["user-rpc", "user"].includes(text(source.kind))) return [{ ...scope, type: "native.event", native: event }];
        const items: DshEvent[] = [];
        const value = blockText(message.content);
        const attachments = list(message.content).filter((block) => record(block).type === "image").map((block) => {
            const image = record(record(block).attachment);
            const attachmentId = text(image.attachmentId);
            return { id: attachmentId, name: text(image.name) || "图片", type: text(image.mediaType), size: Number(image.bytes), width: Number(image.width), height: Number(image.height), url: `/agent/dsh/native-attachments/${encodeURIComponent(this.threadId)}/${encodeURIComponent(attachmentId)}` };
        });
        if (event.type === "tool/result") {
            const call = [...this.events.values()].find((candidate) => candidate.type === "tool/call" && record(candidate.data).callId === id);
            const title = text(record(call?.data).name) || "工具";
            const item = this.item(id, "tool", value, undefined, event.time, { title, ...(attachments.length ? { attachments } : {}), detail: { kind: "tool", status: message.isError ? "failed" : "completed", output: value, meta: data.meta, error: data.error }, native: event });
            return [{ ...scope, type: "tool.completed", itemId: id, item, native: event }];
        }
        const role = event.type === "user/message" ? "user" : "assistant";
        if (value || role === "user" || attachments.length) {
            const item = this.item(id, role, value, undefined, event.time, { ...(source.rpcId ? { clientMessageId: text(source.rpcId) } : {}), ...(attachments.length ? { attachments } : {}), native: event });
            items.push({ ...scope, type: "message.completed", itemId: id, item, native: event });
        }
        const reasoning = blockText(message.content, "reasoning");
        if (reasoning) {
            const item = this.item(`${id}:reasoning`, "reasoning", reasoning, undefined, event.time, { native: event });
            items.push({ ...scope, type: "message.completed", itemId: item.itemId, item, native: event });
        }
        return items;
    }

    messages() {
        const folded = new DshHistory(this.runtimeId, this.threadId);
        const items = new Map<string, DshItem>();
        for (const event of [...this.events.values()].sort((a, b) => a.seq - b.seq)) {
            for (const update of folded.accept(event)) if (update.item) items.set(`${update.turnId}/${update.item.itemId}`, update.item);
        }
        return [...items.values()];
    }

    settledTurnIds() {
        return [...this.events.values()].filter((event) => event.type === "turn/end").map((event) => String(record(event.data).turn));
    }
}
