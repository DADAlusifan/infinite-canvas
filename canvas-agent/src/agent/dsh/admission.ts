import type { Agent, AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { ToolGuard } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session/types";

/** Global MCP tools may only reach the webpage for the admitted foreground runtime tree. */
export function runtimeTreeIncludes(agents: Pick<AgentRegistry, "get" | "list" | "isOwnedBy">, rootId: string | undefined, caller: Agent | undefined) {
    const root = rootId ? agents.get(SessionId(rootId)) : undefined;
    if (!root || !caller || agents.get(caller.id) !== caller) return false;
    const pending = [root];
    const visited = new Set<Agent>();
    const live = agents.list();
    while (pending.length) {
        const parent = pending.shift()!;
        if (parent === caller) return true;
        if (visited.has(parent)) continue;
        visited.add(parent);
        pending.push(...live.filter((child) => agents.isOwnedBy(child.id, parent)));
    }
    return false;
}

export function canvasToolGuard(agents: Pick<AgentRegistry, "get" | "list" | "isOwnedBy">, admittedRoot: () => string | undefined): ToolGuard {
    return (execution) => execution.name.startsWith("mcp__infinite-canvas__") && !runtimeTreeIncludes(agents, admittedRoot(), execution.agent) ? "该 DSH 会话未绑定当前前景画布任务" : undefined;
}
