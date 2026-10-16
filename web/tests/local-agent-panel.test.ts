import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("real Agent controls isolate engine and DSH profile transitions from busy and stale work", () => {
    // Keep DOM globals and module mocks out of the other store/service suites.
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/local-agent-panel.tsx", import.meta.url))], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, NODE_ENV: "test" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Agent menu DOM regression passed");
    expect(result.stdout).toContain("DSH profile DOM regression passed");
}, 25_000);
