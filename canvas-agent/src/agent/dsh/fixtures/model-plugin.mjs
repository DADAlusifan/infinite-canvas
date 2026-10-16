import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { LlmAdapter } from "@deepseek-ai/dsh-llm";

const canvasTool = "mcp__infinite-canvas__canvas_get_state";
const writeRecord = (file, value) => fs.appendFile(path.join(process.cwd(), file), `${JSON.stringify(value)}\n`);
const textOf = (message) => (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
const isUser = (message) => message.role === "user" && (!message.source || ["user", "user-rpc"].includes(message.source.kind));

async function* textResponse(text) {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
}

class FixtureAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: "Local fixture (no network)" }; }
    async listModels() { return [{ provider: "fixture", id: "fixture", name: "Fixture", inputModalities: ["text", "image"] }]; }
    async resolveModel(provider, model) { return { provider, id: model, name: "Fixture", inputModalities: ["text", "image"] }; }

    async *stream(options) {
        const toolNames = (options.tools || []).map((tool) => tool.name);
        assert.ok(toolNames.every((name) => !name.includes("dsh_session_log")), "fixture: session-log tool leaked into model context");
        const messages = options.messages || [];
        const userIndex = messages.findLastIndex(isUser);
        const prompt = userIndex >= 0 ? textOf(messages[userIndex]) : "";
        const imageCount = messages.flatMap((message) => message.content || []).filter((block) => block.type === "image").length;
        const kind = options.purpose || (/Skill 草稿|outputSchema/.test(prompt) ? "draft" : prompt.includes("fixture cancel") ? "cancel" : prompt.includes("fixture tools") ? "tools" : "text");
        await writeRecord("fixture-model-calls.jsonl", { toolNames, imageCount, kind });
        options.signal?.throwIfAborted();

        if (kind === "cancel") {
            assert.ok(options.signal, "fixture: cancellation requires a signal");
            await new Promise((resolve) => {
                if (options.signal.aborted) return resolve();
                options.signal.addEventListener("abort", resolve, { once: true });
            });
            await writeRecord("fixture-model-calls.jsonl", { toolNames, imageCount, kind, canceled: true });
            options.signal.throwIfAborted();
        }

        if (kind === "draft") {
            assert.deepEqual(toolNames, [], "fixture: draft exposed model tools");
            yield* textResponse(JSON.stringify({
                name: "fixture-workflow", displayName: "本地联调流程", description: "提炼并复用画布操作流程。",
                instructions: "先读取画布状态，再按用户要求组织节点，最后核对操作结果。",
                shortDescription: "", defaultPrompt: "使用 /fixture-workflow 执行可复用流程。",
            }));
            return;
        }

        const hasToolResult = messages.slice(userIndex + 1).some((message) => message.role === "tool");
        if (kind === "tools" && !hasToolResult) {
            assert.ok(toolNames.includes(canvasTool), "fixture: Canvas MCP tool is absent; test profile needs native tool presentation");
            const id = `fixture-call-${crypto.randomUUID()}`;
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: 0, id, name: canvasTool, argumentsDelta: "{}" };
            yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: canvasTool, arguments: "{}" } };
            yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
            return;
        }

        yield* textResponse(kind === "tools" ? "fixture tools completed" : options.purpose ? "Fixture" : "fixture text completed");
    }
}

export default {
    name: "infinite-canvas-local-model-fixture",
    inject: ["llm"],
    apply(ctx) {
        const originalFetch = globalThis.fetch;
        const guardedFetch = async (input, init) => {
            const target = new URL(input instanceof Request ? input.url : input);
            const local = target.hostname === "localhost" || target.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(target.hostname);
            if (!local) {
                await writeRecord("fixture-outbound.jsonl", { kind: "blocked", hostname: target.hostname, pathname: target.pathname });
                throw new Error("fixture: non-loopback fetch is forbidden");
            }
            return originalFetch(input, init);
        };
        globalThis.fetch = guardedFetch;
        ctx.effect(() => () => { if (globalThis.fetch === guardedFetch) globalThis.fetch = originalFetch; });
        ctx.llm.registerAdapter(["fixture"], new FixtureAdapter());
    },
};
