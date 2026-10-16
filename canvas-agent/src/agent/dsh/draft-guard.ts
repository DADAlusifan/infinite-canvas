import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";

/** Keep even a PTC-configured Host tool-free, with a final monotonic dispatch denial. */
export function installDraftIsolation(scope: Context, agent: Agent) {
    scope.tools.presentAs("native");
    scope.tools.restrict({ allow: [] });
    scope.tools.guard(() => "Skill 草稿会话禁止执行工具");
    if (scope.tools.schemas(agent).length) throw new Error("Skill 草稿会话工具隔离失败");
}
