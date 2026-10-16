import { create } from "zustand";
import i18n from "@/i18n";

import { fetchAgentSkills, type AgentSkillDraft, type AgentSkillSummary } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";
import { agentSkillMarker, getAgentScope, isCurrentAgentScope, type AgentEngineId } from "@/lib/agent/agent-engine";

let loadSequence = 0;
const engineSkills = new Map<AgentEngineId, Partial<AgentSkillStore>>();

type AgentSkillStore = {
    skills: AgentSkillSummary[];
    selectedSkill: AgentSkillSummary | null;
    selectionRevision: number;
    connectionRevision: number;
    autoPrompt: string;
    draft: AgentSkillDraft | null;
    generatingSource: "conversation" | "canvas" | null;
    loading: boolean;
    loaded: boolean;
    errors: string[];
    loadSkills: (endpoint: string, token: string, forceReload?: boolean) => Promise<void>;
    selectSkill: (skill: AgentSkillSummary | null, prompt?: string) => void;
    clearSelection: (expectedRevision?: number) => void;
    setDraft: (draft: AgentSkillDraft | null) => void;
    setGeneratingSource: (source: "conversation" | "canvas" | null) => void;
    reset: () => void;
};

export const useAgentSkillStore = create<AgentSkillStore>((set, get) => ({
    skills: [],
    selectedSkill: null,
    selectionRevision: 0,
    connectionRevision: 0,
    autoPrompt: "",
    draft: null,
    generatingSource: null,
    loading: false,
    loaded: false,
    errors: [],
    loadSkills: async (endpoint, token, forceReload = false) => {
        const sequence = ++loadSequence;
        const scope = getAgentScope();
        set({ loading: true });
        try {
            const response = await fetchAgentSkills(endpoint, token, forceReload);
            if (sequence !== loadSequence || !isCurrentAgentScope(scope)) return;
            const skills = response.data || [];
            const current = get();
            const selected = current.selectedSkill;
            const selectedSkill = selected ? skills.find((item) => item.name === selected.name && item.path === selected.path && item.enabled) || null : null;
            const selectionChanged = Boolean(selected && !selectedSkill);
            if (selectionChanged) clearSelectedSkillPrompt(current);
            const autoPrompt = selectedSkill
                ? replaceAutoPrompt(current.autoPrompt, selectedSkill.interface?.defaultPrompt?.trim() || agentSkillMarker(scope.engineId, selectedSkill.name), false)
                : "";
            set({ skills, selectedSkill, autoPrompt, selectionRevision: current.selectionRevision + (selectionChanged ? 1 : 0), loading: false, loaded: true, errors: (response.errors || []).map(skillErrorText) });
        } catch (error) {
            if (sequence !== loadSequence || !isCurrentAgentScope(scope)) return;
            set({ loading: false, loaded: true, errors: [error instanceof Error ? error.message : i18n.t("agent.state.skillReadFailed")] });
        }
    },
    selectSkill: (selectedSkill, prompt) => {
        const current = get();
        const agent = useAgentStore.getState();
        const marker = selectedSkill ? agentSkillMarker(agent.engineId, selectedSkill.name) : "";
        const previousMarker = current.selectedSkill ? agentSkillMarker(agent.engineId, current.selectedSkill.name) : "";
        let nextPrompt = prompt;
        let autoPrompt = "";
        if (nextPrompt === undefined && selectedSkill) {
            const defaultPrompt = selectedSkill.interface?.defaultPrompt?.trim() || marker;
            if (!agent.prompt.trim() || Boolean(current.autoPrompt && agent.prompt === current.autoPrompt)) {
                nextPrompt = defaultPrompt;
                autoPrompt = defaultPrompt;
            } else if (previousMarker && agent.prompt.includes(previousMarker)) {
                nextPrompt = agent.prompt.replace(previousMarker, marker);
            } else {
                nextPrompt = agent.prompt.includes(marker) ? agent.prompt : `${agent.prompt}${/\s$/.test(agent.prompt) ? "" : " "}${marker}`;
            }
        }
        if (nextPrompt !== undefined && agent.prompt !== nextPrompt) agent.setAgentState({ prompt: nextPrompt });
        set({ selectedSkill, autoPrompt, selectionRevision: current.selectionRevision + 1 });
    },
    clearSelection: (expectedRevision) => {
        const current = get();
        if (expectedRevision !== undefined && expectedRevision !== current.selectionRevision) return;
        clearSelectedSkillPrompt(current);
        set({ selectedSkill: null, autoPrompt: "", selectionRevision: current.selectionRevision + 1 });
    },
    setDraft: (draft) => set({ draft }),
    setGeneratingSource: (generatingSource) => {
        useAgentStore.getState().setAgentState({ draftingSkill: Boolean(generatingSource) });
        set({ generatingSource });
    },
    reset: () => {
        loadSequence += 1;
        useAgentStore.getState().setAgentState({ draftingSkill: false });
        const current = get();
        set({ skills: [], selectionRevision: current.selectionRevision + 1, connectionRevision: current.connectionRevision + 1, generatingSource: null, loading: false, loaded: false, errors: [] });
    },
}));

useAgentStore.subscribe((state, previous) => {
    if (state.engineId === previous.engineId && state.runtimeId === previous.runtimeId) return;
    loadSequence += 1;
    const current = useAgentSkillStore.getState();
    const { selectedSkill, autoPrompt, draft } = current;
    engineSkills.set(previous.engineId, { selectedSkill, autoPrompt, draft });
    const saved = engineSkills.get(state.engineId);
    useAgentSkillStore.setState({ skills: [], selectedSkill: null, autoPrompt: "", draft: null, ...saved, selectionRevision: current.selectionRevision + 1, connectionRevision: current.connectionRevision + 1, generatingSource: null, loading: false, loaded: false, errors: [] });
});

function replaceAutoPrompt(previous: string, next: string, fillEmpty: boolean) {
    const agent = useAgentStore.getState();
    const ownsPrompt = Boolean(previous && agent.prompt === previous);
    if (!ownsPrompt && !(fillEmpty && !agent.prompt.trim())) return "";
    if (agent.prompt !== next) agent.setAgentState({ prompt: next });
    return next;
}

function clearSelectedSkillPrompt(selection: Pick<AgentSkillStore, "selectedSkill" | "autoPrompt">) {
    const agent = useAgentStore.getState();
    if (selection.autoPrompt && agent.prompt === selection.autoPrompt) {
        agent.setAgentState({ prompt: "" });
        return;
    }
    if (!selection.selectedSkill) return;
    const marker = agentSkillMarker(agent.engineId, selection.selectedSkill.name);
    if (agent.prompt.includes(marker)) agent.setAgentState({ prompt: agent.prompt.replace(marker, "") });
}

function skillErrorText(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return i18n.t("agent.state.skillParseFailed");
    const item = value as { path?: unknown; error?: unknown; message?: unknown };
    const message = typeof item.error === "string" ? item.error : typeof item.message === "string" ? item.message : i18n.t("agent.state.skillParseFailed");
    return typeof item.path === "string" ? `${item.path}：${message}` : message;
}
