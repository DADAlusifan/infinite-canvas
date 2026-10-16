export type AgentEngineId = "codex" | "dsh";
export type DshConfigProfile = "web" | "desktop";
export type AgentScope = { engineId: AgentEngineId; runtimeId: string };
export type AgentEngineDescriptor = {
    id: AgentEngineId;
    name: string;
    configProfile?: DshConfigProfile;
    capabilities: {
        permissions: Array<{ id: string; title: string; description?: string }>;
        defaultPermissionMode?: string;
        skills: boolean;
        attachments: boolean;
        manageSettings: boolean;
    };
};

export const CODEX_ENGINE: AgentEngineDescriptor = {
    id: "codex", name: "Codex",
    capabilities: {
        permissions: [
            { id: "request", title: "请求批准", description: "按 Codex 的工作区权限和审批策略执行" },
            { id: "automatic", title: "自动审查", description: "由 Codex 审查操作，需要时请求批准" },
            { id: "full", title: "完全访问", description: "允许访问本机文件和网络" },
        ],
        defaultPermissionMode: "request", skills: true, attachments: true, manageSettings: false,
    },
};

export function isAgentEngine(value: unknown): value is AgentEngineId {
    return value === "codex" || value === "dsh";
}
