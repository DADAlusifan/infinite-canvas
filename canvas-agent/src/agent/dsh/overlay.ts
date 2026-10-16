import { Document, Scalar } from "yaml";

/** Credentials are evaluated from the owned child's environment, never serialized. */
export function createDshOverlay(input: { command: string; entry: string; cwd: string; execArgv: string[] }) {
    const environment = new Scalar("Object.fromEntries(['CANVAS_AGENT_ENGINE_ID','CANVAS_AGENT_RUNTIME_ID','CANVAS_AGENT_URL','CANVAS_AGENT_TOKEN','DSH_HOME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))");
    environment.tag = "tag:yaml.org,2002:js";
    const document = new Document([
        { id: "session-log-deepseek", config: { enabled: false } },
        ...["otel", "session-telemetry-otel", "desktop-product-telemetry", "product-analytics"].map((id) => ({ id, disabled: true })),
        { id: "webserver", config: { host: "127.0.0.1", port: 0 } },
        { id: "connection", config: { trustedHosts: [] } },
        { id: "web-runtime", config: { openBrowser: false, printUrl: false, surfaceContext: true } },
        { insert: [{ id: "infinite-canvas-mcp", name: "@deepseek-ai/dsh-mcp-client", config: { transport: "stdio", serverName: "infinite-canvas", command: input.command, args: [...input.execArgv, input.entry, "mcp"], cwd: input.cwd, failOnStartupError: true, env: environment } }] },
    ]);
    return document.toString();
}
