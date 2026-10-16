import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { assembleAssistantStream } from "@deepseek-ai/dsh-llm/assistant-stream";
import type { AssistantStreamRecord } from "@deepseek-ai/dsh-llm/assistant-stream";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { SessionFollowFrame, SessionHistoryRecord, SessionWireHeader, SessionWireEvent } from "@deepseek-ai/dsh-api-session-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ClientRemote } from "@deepseek-ai/dsh-api-gateway/client";
import { DshHistory, blockText, record, type DshEvent } from "./history.js";
import { unwrapDsh } from "./transport.js";

/** One native journal, paged backwards and followed with official reconnect generations. */
export class DshSession {
    readonly history: DshHistory;
    header?: SessionWireHeader;
    private cursor = -1;
    private opening: Promise<void>;
    private resolveOpening!: () => void;
    private rejectOpening!: (error: unknown) => void;
    private failed?: Error;
    private waiting = new Set<{ seq: number; resolve(): void; reject(error: Error): void }>();
    private attempts = new Map<string, { turnId: string; step: number; assembler: BlockAssembler; nextIndex: number; itemId: string }>();
    private task: Promise<void>;
    private stream;
    private closed = false;
    private opened = false;

    constructor(private readonly remote: ClientRemote, runtimeId: string, readonly id: SessionId, private readonly emit: (event: DshEvent) => void) {
        this.history = new DshHistory(runtimeId, id);
        this.opening = new Promise((resolve, reject) => { this.resolveOpening = resolve; this.rejectOpening = reject; });
        this.stream = remote.$stream<SessionFollowFrame>({
            name: `infinite-canvas:${id}`,
            open: (signal) => remote.session.follow({ address: { kind: "session", sessionId: id }, assistantStream: true }, signal),
            ended: () => new Error("DSH 原生会话流意外结束"),
        });
        this.task = this.follow().catch((error: unknown) => {
            this.failed = error instanceof Error ? error : new Error(String(error));
            this.rejectOpening(this.failed);
            for (const waiter of this.waiting) waiter.reject(this.failed);
            this.waiting.clear();
            if (!this.closed) this.emit({ ...this.history.scope(), type: "runtime.error", message: this.failed.message });
        });
    }

    async ready() { await this.opening; }
    async through(seq: number) {
        await this.ready();
        if (this.failed) throw this.failed;
        if (this.cursor >= seq) return;
        await new Promise<void>((resolve, reject) => this.waiting.add({ seq, resolve, reject }));
    }
    async close() {
        this.closed = true;
        const error = new Error("DSH 会话已关闭");
        this.rejectOpening(error);
        for (const waiter of this.waiting) waiter.reject(error);
        this.waiting.clear();
        await this.stream.dispose(); await this.task;
    }

    private notifyCursor() {
        for (const waiter of this.waiting) if (this.cursor >= waiter.seq) { this.waiting.delete(waiter); waiter.resolve(); }
    }

    private publish(event: SessionWireEvent) {
        const updates = this.history.accept(event);
        for (const update of updates) {
            if (event.type === "assistant/message") {
                const data = record(event.data);
                const attempt = [...this.attempts.entries()].find(([, value]) => value.turnId === String(data.turn) && value.step === data.step);
                if (attempt && update.item) update.removeItemId = `${attempt[1].itemId}${update.item.role === "reasoning" ? ":reasoning" : ""}`;
            }
            this.emit(update);
        }
        if (updates.length && event.type === "assistant/message" && record(event.data).usage) {
            const usage = record(record(event.data).usage);
            this.emit({ ...this.history.scope(), type: "usage.updated", usage: { input: usage.inputTokens, cached: usage.cacheReadTokens || 0, output: usage.outputTokens }, native: usage });
        }
        if (event.type === "assistant/message" || event.type === "assistant/attempt") {
            const data = record(event.data);
            for (const [id, attempt] of this.attempts) if (attempt.turnId === String(data.turn) && attempt.step === data.step) {
                if (event.type === "assistant/attempt") this.emit({ ...this.history.scope(attempt.turnId), type: "message.withdrawn", removeItemId: id });
                this.attempts.delete(id);
            }
        }
        this.cursor = Math.max(this.cursor, event.seq);
        this.notifyCursor();
    }

    private async baseline(frame: Extract<SessionFollowFrame, { type: "snapshot" }>, signal: AbortSignal) {
        this.header = frame.header;
        const records: SessionHistoryRecord[] = [...frame.records];
        let more = frame.hasMore;
        while (more) {
            const beforeSeq = Math.min(...records.map((record) => record.event.seq));
            if (!Number.isFinite(beforeSeq)) throw new Error("DSH 历史分页缺少原生游标");
            const page = unwrapDsh(await this.remote.session.page({ address: { kind: "session", sessionId: this.id }, throughSeq: frame.cursor, beforeSeq }, signal));
            if (page.hasMore && (!page.records.length || page.records.every((entry) => entry.event.seq >= beforeSeq))) throw new Error("DSH 历史分页游标未推进");
            records.unshift(...page.records);
            more = page.hasMore;
        }
        // Baselines are authoritative; only later native sequence numbers supplement them.
        signal.throwIfAborted();
        this.history.events.clear();
        this.history.currentTurn = "";
        for (const entry of records.sort((a, b) => a.event.seq - b.event.seq)) this.history.accept(entry.event);
        this.cursor = frame.cursor;
        const removeItemIds = [...this.attempts.keys()].flatMap((id) => [id, `${id}:reasoning`]);
        this.attempts.clear();
        if (this.opened) this.emit({ ...this.history.scope(), type: "history.snapshot", messages: this.history.messages(), settledTurnIds: this.history.settledTurnIds(), removeItemIds });
        this.opened = true;
        const active = frame.assistantStream?.activeAttempt;
        if (active) {
            const assembler = assembleAssistantStream(active.stream as readonly AssistantStreamRecord[]);
            this.attempts.set(active.attemptId, { turnId: String(active.turn), step: active.step, assembler, nextIndex: active.nextIndex, itemId: active.attemptId });
            this.publishAttempt(active.attemptId);
        }
        this.notifyCursor();
        this.resolveOpening();
    }

    private publishAttempt(id: string) {
        const attempt = this.attempts.get(id);
        if (!attempt) return;
        const value = blockText(attempt.assembler.blocks());
        if (value) this.emit({ ...this.history.scope(attempt.turnId), type: "message.updated", itemId: id, item: this.history.item(id, "assistant", value, attempt.turnId) });
        const reasoning = blockText(attempt.assembler.blocks(), "reasoning");
        if (reasoning) this.emit({ ...this.history.scope(attempt.turnId), type: "message.updated", itemId: `${id}:reasoning`, item: this.history.item(`${id}:reasoning`, "reasoning", reasoning, attempt.turnId) });
    }

    private async follow() {
        for await (const generation of this.stream) {
            if (generation.signal.aborted) continue;
            const frame = generation.value;
            if (frame.type === "snapshot") {
                try { await this.baseline(frame, generation.signal); }
                catch (error) { if (generation.signal.aborted) continue; throw error; }
                if (!generation.signal.aborted) generation.accept();
            } else if (frame.type === "event") this.publish(frame.event);
            else {
                const value = frame.frame;
                if (value.type === "start") this.attempts.set(value.attemptId, { turnId: String(value.turn), step: value.step, assembler: new BlockAssembler(), nextIndex: 0, itemId: value.attemptId });
                else if (value.type === "chunk") {
                    const attempt = this.attempts.get(value.attemptId);
                    if (!attempt || value.index !== attempt.nextIndex) throw new Error("DSH 实时消息序号不连续");
                    attempt.nextIndex++;
                    attempt.assembler.push(value.chunk as unknown as StreamChunk);
                    this.publishAttempt(value.attemptId);
                } else if (value.outcome.kind === "abandoned") {
                    this.emit({ ...this.history.scope(this.attempts.get(value.attemptId)?.turnId), type: "message.withdrawn", removeItemId: value.attemptId });
                    this.attempts.delete(value.attemptId);
                }
            }
        }
    }
}
