import { acceptsAgentEvent } from "@/lib/agent/agent-engine";
import type { AgentChatItem } from "@/stores/use-agent-store";
import i18n from "@/i18n";
import { scopeChatItem, upsertAgentMessage } from "./agent-event-formatters";

export type DshEvent = {
    type: string;
    engineId: "dsh";
    runtimeId: string;
    threadId: string;
    turnId: string;
    itemId?: string;
    removeItemId?: string;
    item?: { id: string; role: AgentChatItem["role"] | "reasoning"; text: string; title?: string; detail?: unknown; clientMessageId?: string; attachments?: AgentChatItem["attachments"] };
    messages?: AgentChatItem[];
    settledTurnIds?: string[];
    removeItemIds?: string[];
    native?: unknown;
    error?: string | { message?: string; code?: string };
    message?: string;
    status?: string;
    usage?: { input: number; cached: number; output: number };
};

export function normalizeDshChatItem(item: Omit<AgentChatItem, "role"> & { role: string }, streaming = false): AgentChatItem {
    return item.role === "reasoning"
        ? { ...item, role: "tool", title: i18n.t("agent.events.reasoning"), detail: { kind: "reasoning", status: streaming ? "inProgress" : "completed" } }
        : item as AgentChatItem;
}

export function mergeDshEventMessage(messages: AgentChatItem[], event: DshEvent) {
    if (!acceptsAgentEvent(event) || !event.threadId || !event.turnId) return messages;
    if (!event.item) return event.removeItemId ? messages.filter((item) => item.threadId !== event.threadId || item.turnId !== event.turnId || ![event.removeItemId, `${event.removeItemId}:reasoning`].includes(item.itemId || "")) : messages;
    const itemId = event.itemId || event.item.id;
    if (!itemId) return messages;
    const item = scopeChatItem(normalizeDshChatItem({ ...event.item, id: itemId, itemId, detail: event.item.detail || event.native, streamId: event.type === "message.updated" && event.item.role === "assistant" ? itemId : undefined }, event.type === "message.updated"), event.threadId, event.turnId);
    const remaining = messages.filter((message) => {
        if (message.threadId !== event.threadId) return true;
        if (event.removeItemId && message.turnId === event.turnId && message.itemId === event.removeItemId) return false;
        return item.role !== "user" || !item.clientMessageId || message.clientMessageId !== item.clientMessageId || message.id === item.id;
    });
    return upsertAgentMessage(remaining, item);
}
