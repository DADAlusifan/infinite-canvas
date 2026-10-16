import fs from "node:fs/promises";
import path from "node:path";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { provider } from "./route.js";

class ProfileAdapter extends LlmAdapter {
    providerInfo() { return { id: provider, name: provider }; }
    async listModels() { return [{ provider, id: `${provider}-model`, name: provider, inputModalities: ["text"] }]; }
    async resolveModel(_provider, model) { return { provider, id: model, name: provider, inputModalities: ["text"] }; }
    async *stream() { throw new Error("profile fixture must never call a model"); }
}

export default {
    name: "profile-source-fixture",
    inject: ["llm", "profileContext"],
    async apply(ctx) {
        ctx.llm.registerAdapter([provider], new ProfileAdapter());
        await fs.appendFile(path.join(process.cwd(), "profile-runtime.jsonl"), `${JSON.stringify({ provider, profile: ctx.profileContext.name, dir: ctx.profileContext.dir, patchPath: ctx.profileContext.patchPath })}\n`);
    },
};
