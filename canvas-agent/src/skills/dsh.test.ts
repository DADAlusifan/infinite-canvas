import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import matter from "gray-matter";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";

import { SkillStoreError } from "./document.js";
import { DshSkillStore } from "./dsh-store.js";
import { DshSkillService, generateDshSkillDraft, withDshSkill, type DshSkillsRuntime } from "./dsh.js";
import { redactSkillSourceText } from "./draft.js";

const draft = { name: "workflow", displayName: "可复用流程", description: "提炼并执行可复用画布流程", instructions: "先识别输入，再按依赖顺序执行流程。", shortDescription: "", defaultPrompt: "请使用 /workflow 执行流程。" };

test("DSH 已选 Skill 只对原生独立空白 token 去重，正文相似字符串不阻止注入", () => {
    for (const prompt of ["/workflow", "/workflow 执行流程", "请使用 /workflow 执行流程", "步骤\n/workflow\t继续"]) {
        assert.equal(withDshSkill(prompt, "workflow"), prompt);
    }
    for (const prompt of ["/workflow-extra 执行流程", "/workflow/path", "请使用/workflow 执行流程", "请使用 /workflow。", "使用 `/workflow` 执行流程"]) {
        assert.equal(withDshSkill(prompt, "workflow"), `/workflow ${prompt}`);
    }
});

test("对话草稿复用画布敏感文本替换且不新增长度截断", () => {
    const steps = "保留完整可复用步骤。".repeat(2000);
    const source = `${steps}\n文件 C:\\private\\workflow.txt、file:///var/private/source.txt；媒体 data:image/png;base64,cHJpdmF0ZQ== blob:private-media；外部 https://media.example/private.png\nAPI_KEY=sk-secretprivate123456 Bearer privatebearertoken123456`;
    const clean = redactSkillSourceText(source);
    assert.ok(clean.startsWith(steps));
    assert.ok(clean.length > 12000);
    assert.doesNotMatch(clean, /C:\\private|file:\/\/\/var|data:image|blob:private|media\.example|sk-secretprivate|privatebearertoken|内容已截断/);
    assert.match(clean, /\[本地路径已移除\]/);
    assert.match(clean, /\[敏感凭证已移除\]/);
});

test("DSH 文档 CRUD、状态开关和 revision 共享同一写入边界并保留未知 frontmatter", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-dsh-skills-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new DshSkillStore(workspace);
    const created = await store.create({ name: draft.name, description: draft.description, instructions: draft.instructions, interface: { displayName: draft.displayName, defaultPrompt: draft.defaultPrompt } });
    assert.equal(created.path, path.join(workspace, ".dsh", "skills", "workflow", "SKILL.md"));
    await assert.rejects(fs.access(path.join(path.dirname(created.path), "agents", "openai.yaml")));
    await assert.rejects(store.create({ name: draft.name, description: draft.description, instructions: draft.instructions }), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 409);
    await assert.rejects(store.create({ name: "escape", description: draft.description, instructions: draft.instructions, interface: { defaultPrompt: "使用 $escape" } }), /\/escape/);

    const raw = await fs.readFile(created.path, "utf8");
    const parsed = matter(raw);
    parsed.data["allowed-tools"] = ["Read"];
    parsed.data.custom = { nested: ["keep", 7] };
    parsed.data.metadata["infinite-canvas"].extra = "保留界面扩展字段";
    parsed.data.metadata.other = { retain: true };
    await fs.writeFile(created.path, matter.stringify(parsed.content, parsed.data));
    await assert.rejects(store.setEnabled("workflow", false, created.revision), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 409);
    const current = await store.get("workflow");
    const disabled = await store.setEnabled("workflow", false, current.revision);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.modelInvocable, false);
    const disabledData = matter(await fs.readFile(disabled.path, "utf8")).data;
    assert.equal(disabledData["disable-model-invocation"], true);
    assert.equal(disabledData["user-invocable"], false);
    assert.deepEqual(disabledData.custom, { nested: ["keep", 7] });
    assert.deepEqual(disabledData["allowed-tools"], ["Read"]);

    const updated = await store.update("workflow", { description: "更新流程", instructions: "按输入执行流程。", interface: null, expectedRevision: disabled.revision });
    assert.equal(updated.enabled, false);
    assert.equal(updated.interface, undefined);
    const updatedData = matter(await fs.readFile(updated.path, "utf8")).data;
    assert.deepEqual(updatedData.metadata["infinite-canvas"], { extra: "保留界面扩展字段" });
    assert.deepEqual(updatedData.metadata.other, { retain: true });
    const enabled = await store.setEnabled("workflow", true, updated.revision);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.modelInvocable, true);
    await assert.rejects(store.delete("workflow", updated.revision), /其他窗口/);
    await store.delete("workflow", enabled.revision);
    await assert.rejects(store.get("workflow"), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 404);
});

test("DSH 使用原生目录发现外部只读技能并补回当前站点被隐藏的停用文档", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-dsh-skills-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const calls: unknown[] = [];
    let catalog: unknown[] = [{ name: "native-only", description: "只允许显式调用", path: path.join(os.tmpdir(), "outside-skills", "native-only", "SKILL.md"), modelInvocable: false }];
    const runtime: DshSkillsRuntime = { listSkills: async (input) => { calls.push(input); return { skills: catalog }; }, generateSkillDraft: async () => { throw new Error("不得生成草稿"); } };
    const service = new DshSkillService(workspace, runtime);
    const created = await service.create({ name: draft.name, description: draft.description, instructions: draft.instructions });
    catalog = [...catalog, { name: created.name, description: created.description, path: created.path, modelInvocable: true }];
    const selected = await service.resolve({ name: created.name, path: created.path }, true, "session-a");
    assert.equal(selected.managed, true);
    assert.equal(selected.revision, created.revision);
    await service.setEnabled(created.name, false, created.revision);
    catalog = catalog.slice(0, 1);
    const list = await service.list("session-a");
    assert.deepEqual(calls.at(-1), { sessionId: "session-a", forceReload: true });
    assert.equal(list.skills.find((skill) => skill.name === draft.name)?.enabled, false);
    assert.equal(list.skills.find((skill) => skill.name === "native-only")?.managed, false);
    assert.equal((await service.resolve({ name: "native-only", path: String((catalog[0] as { path: string }).path) }, true)).enabled, true);
    await assert.rejects(service.resolve({ name: created.name, path: created.path }, true), /已停用/);
    await assert.rejects(service.get("native-only"), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 404);
    await assert.rejects(service.get("../native-only"), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 400);
});

test("官方 DSH provider 能读取管理文档、原生停用标志以及 git 子目录的指定站点根", async (context) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-dsh-native-skills-"));
    context.after(() => fs.rm(project, { recursive: true, force: true }));
    await fs.mkdir(path.join(project, ".git"));
    const workspace = path.join(project, "site");
    await fs.mkdir(workspace);
    const store = new DshSkillStore(workspace);
    const created = await store.create({ name: draft.name, description: draft.description, instructions: draft.instructions, interface: { displayName: draft.displayName, defaultPrompt: draft.defaultPrompt } });
    const warnings: string[] = [];
    const host = { get: () => undefined, logger: { warn: (message: string) => warnings.push(message) } };
    const config = { watch: false, dshHome: path.join(project, "dsh-home"), agentsHome: path.join(project, "agents-home") };
    const control = { signal: new AbortController().signal, invalidate: () => undefined };
    const defaults = new FileSystemSkillProvider(host as never, control, config);
    const managed = new FileSystemSkillProvider(host as never, control, { ...config, customSkillDirs: [store.skillsPath] });
    context.after(async () => { await defaults.dispose(); await managed.dispose(); });
    assert.deepEqual(await defaults.list({ cwd: workspace }), []);
    const before = await managed.list({ cwd: workspace });
    assert.ok(Array.isArray(before));
    assert.equal(before[0].name, draft.name);
    assert.deepEqual(before[0].metadata?.["infinite-canvas"], { displayName: draft.displayName, defaultPrompt: draft.defaultPrompt });
    await store.setEnabled(created.name, false, created.revision);
    const after = await managed.list({ cwd: workspace });
    assert.ok(Array.isArray(after));
    assert.deepEqual(after[0].invocation, { modelInvocable: false, userInvocable: false });
    assert.deepEqual(warnings, []);
});

test("DSH 拒绝通过目录联接越界读取、写入或删除技能", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-dsh-skills-"));
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-dsh-external-"));
    context.after(async () => { await fs.rm(workspace, { recursive: true, force: true }); await fs.rm(external, { recursive: true, force: true }); });
    const store = new DshSkillStore(workspace);
    const created = await store.create({ name: draft.name, description: draft.description, instructions: draft.instructions });
    await fs.symlink(external, path.join(store.skillsPath, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(store.get("linked"), /不安全/);
    await assert.rejects(store.create({ name: "linked", description: draft.description, instructions: draft.instructions }), /符号链接/);
    await fs.symlink(external, path.join(path.dirname(created.path), "external"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(external, "keep.txt"), "保留");
    await assert.rejects(store.delete(created.name, created.revision), /符号链接/);
    assert.equal(await fs.readFile(path.join(external, "keep.txt"), "utf8"), "保留");
});

test("DSH 草稿共享画布脱敏和输出校验，失败及取消不写 Skill、不重试或改动活动会话", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-dsh-draft-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const active = { threadId: "active-thread", turnId: "active-turn" };
    const calls: Parameters<DshSkillsRuntime["generateSkillDraft"]>[0][] = [];
    let result = JSON.stringify(draft);
    const runtime: DshSkillsRuntime = { listSkills: async () => ({ skills: [] }), generateSkillDraft: async (input) => { calls.push(input); return result; } };
    const snapshot = { projectId: "project-private", clientId: "client-private", nodes: [{ id: "node-private", type: "text" as const, position: { x: 0, y: 0 }, width: 100, height: 80, metadata: { content: "先分析，再生成；参考 https://media.example/private.png；API_KEY=sk-secretprivate123456", token: "private-token" } }], connections: [] };
    const service = new DshSkillService(workspace, runtime);
    assert.deepEqual(await service.generateDraft({ source: "canvas", snapshot, model: "native-model", provider: "native-provider", effort: "high" }), draft);
    assert.equal(calls[0].source, "canvas");
    assert.doesNotMatch(calls[0].prompt, /media\.example|sk-secretprivate|private-token|node-private/);
    assert.equal(calls[0].model, "native-model");
    assert.equal(calls[0].provider, "native-provider");
    assert.match(calls[0].prompt, /\/skill-name/);
    assert.deepEqual(active, { threadId: "active-thread", turnId: "active-turn" });
    assert.deepEqual(await fs.readdir(workspace), []);

    result = "invalid json";
    await assert.rejects(service.generateDraft({ source: "conversation", threadId: active.threadId }), /有效 JSON/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].threadId, active.threadId);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(generateDshSkillDraft(runtime, { source: "canvas", snapshot, signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls.length, 2);
    result = JSON.stringify({ ...draft, instructions: "读取 /var/lib/private.png" });
    await assert.rejects(service.generateDraft({ source: "canvas", snapshot }), /本地路径/);
    result = JSON.stringify({ ...draft, instructions: "读取 /workflow/private.png" });
    await assert.rejects(service.generateDraft({ source: "canvas", snapshot }), /本地路径/);
    assert.deepEqual(await fs.readdir(workspace), []);
});
