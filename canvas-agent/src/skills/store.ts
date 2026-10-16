import fs from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { SkillFiles } from "./files.js";
import { SkillStoreError, assertTreeHasNoLinks, inside, assertRevision, ensurePlainDirectory, expectedRevisionValue, lstatOptional, nodeErrorCode, readSkill, recordValue, revision, serializeSkill, skillDescription, skillInstructions, skillInterfaceValue, skillName, storeError, writeFileAtomic, type CreateManagedSkillInput, type ManagedSkillInterface, type UpdateManagedSkillInput } from "./document.js";
export { SkillStoreError } from "./document.js";
export type { CreateManagedSkillInput, ManagedSkillInterface, UpdateManagedSkillInput } from "./document.js";

export type ManagedSkillDetail = {
    name: string;
    description: string;
    instructions: string;
    interface?: ManagedSkillInterface;
    path: string;
    revision: string;
    managed: true;
};

type OpenAiDocument = { raw: string; data: Record<string, unknown>; interface?: ManagedSkillInterface };

/** 只管理站点工作空间下 `.agents/skills` 中的画布专属 Skill。 */
export class SkillStore extends SkillFiles {

    constructor(workspacePath: string) {
        super(workspacePath, ".agents");
    }

    /** 读取一个可编辑 Skill 的正文与界面元数据。 */
    async get(name: string): Promise<ManagedSkillDetail> {
        try {
            await this.writeQueue.catch(() => undefined);
            const paths = await this.safeCodexPaths(name);
            return await this.readDetail(name, paths.skillFile, paths.openAiFile);
        } catch (error) {
            throw storeError(error, "读取 Skill 失败");
        }
    }

    /** 创建新的画布专属 Skill。 */
    create(input: CreateManagedSkillInput) {
        return this.mutate(async () => {
            const name = skillName(input?.name);
            const description = skillDescription(input?.description);
            const instructions = skillInstructions(input?.instructions);
            const skillInterface = skillInterfaceValue(input?.interface, name);
            await this.ensureRoot();
            const skillDir = path.join(this.skillsPath, name);
            const existing = await lstatOptional(skillDir);
            if (existing) {
                if (existing.isSymbolicLink()) throw new SkillStoreError("Skill 目录不能是符号链接或目录联接", 400);
                throw new SkillStoreError("同名 Skill 已存在", 409);
            }
            await fs.mkdir(skillDir);
            try {
                const skillFile = path.join(skillDir, "SKILL.md");
                await writeFileAtomic(skillFile, serializeSkill({ name, description }, instructions));
                const openAiFile = path.join(skillDir, "agents", "openai.yaml");
                if (skillInterface) await this.writeOpenAi(openAiFile, {}, skillInterface);
                return await this.readDetail(name, skillFile, openAiFile);
            } catch (error) {
                await fs.rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
                throw error;
            }
        });
    }

    /** 通过 revision 防止覆盖已被其他窗口或外部编辑器修改的内容。 */
    update(nameValue: string, input: UpdateManagedSkillInput) {
        return this.mutate(async () => {
            const name = skillName(nameValue);
            const description = skillDescription(input?.description);
            const instructions = skillInstructions(input?.instructions);
            const expectedRevision = expectedRevisionValue(input?.expectedRevision);
            const interfaceInput = input?.interface;
            const skillInterface = interfaceInput === undefined ? undefined : skillInterfaceValue(interfaceInput, name);
            const paths = await this.safeCodexPaths(name);
            const currentSkill = await readSkill(paths.skillFile, name);
            const currentOpenAi = await readOpenAi(paths.openAiFile, name);
            assertRevision(expectedRevision, revision(currentSkill.raw, currentOpenAi.raw));
            const frontmatter = { ...currentSkill.frontmatter, name, description };
            await writeFileAtomic(paths.skillFile, serializeSkill(frontmatter, instructions));
            if (interfaceInput !== undefined) {
                try {
                    await this.writeOpenAi(paths.openAiFile, currentOpenAi.data, skillInterface);
                } catch (error) {
                    if (!await restoreSkillFiles(paths.skillFile, currentSkill.raw, paths.openAiFile, currentOpenAi.raw)) {
                        throw new SkillStoreError("Skill 更新失败且无法完全恢复，请检查本地文件", 500);
                    }
                    throw error;
                }
            }
            return await this.readDetail(name, paths.skillFile, paths.openAiFile);
        });
    }

    /** 删除 revision 仍匹配的画布专属 Skill。 */
    delete(nameValue: string, expectedRevisionValueInput: string) {
        return this.mutate(async () => {
            const name = skillName(nameValue);
            const expectedRevision = expectedRevisionValue(expectedRevisionValueInput);
            const paths = await this.safeCodexPaths(name);
            const currentSkill = await readSkill(paths.skillFile, name);
            const currentOpenAi = await readOpenAi(paths.openAiFile, name);
            assertRevision(expectedRevision, revision(currentSkill.raw, currentOpenAi.raw));
            await assertTreeHasNoLinks(paths.skillDir);
            const realRoot = await fs.realpath(this.skillsPath);
            const realSkill = await fs.realpath(paths.skillDir);
            if (!inside(realRoot, realSkill)) throw new SkillStoreError("Skill 路径不安全", 400);
            await fs.rm(realSkill, { recursive: true });
        });
    }

    private async safeCodexPaths(nameValue: string) {
        const paths = await this.safeExistingPaths(nameValue);
        const agentsDir = path.join(paths.skillDir, "agents");
        const agentsEntry = await lstatOptional(agentsDir);
        if (agentsEntry && (agentsEntry.isSymbolicLink() || !agentsEntry.isDirectory())) throw new SkillStoreError("Skill agents 目录不安全", 400);
        const openAiFile = path.join(agentsDir, "openai.yaml");
        const openAiEntry = await lstatOptional(openAiFile);
        if (openAiEntry && (openAiEntry.isSymbolicLink() || !openAiEntry.isFile())) throw new SkillStoreError("openai.yaml 路径不安全", 400);
        return { ...paths, openAiFile };
    }

    private async readDetail(name: string, skillFile: string, openAiFile: string): Promise<ManagedSkillDetail> {
        const skill = await readSkill(skillFile, name);
        const openAi = await readOpenAi(openAiFile, name);
        return {
            name,
            description: skill.description,
            instructions: skill.instructions,
            ...(openAi.interface ? { interface: openAi.interface } : {}),
            path: skillFile,
            revision: revision(skill.raw, openAi.raw),
            managed: true,
        };
    }

    private async writeOpenAi(filePath: string, current: Record<string, unknown>, skillInterface?: ManagedSkillInterface) {
        const agentsDir = path.dirname(filePath);
        const existing = recordValue(current.interface);
        delete existing.display_name;
        delete existing.short_description;
        delete existing.default_prompt;
        const interfaceYaml = {
            ...existing,
            ...(skillInterface?.displayName ? { display_name: skillInterface.displayName } : {}),
            ...(skillInterface?.shortDescription ? { short_description: skillInterface.shortDescription } : {}),
            ...(skillInterface?.defaultPrompt ? { default_prompt: skillInterface.defaultPrompt } : {}),
        };
        const next = { ...current };
        if (Object.keys(interfaceYaml).length) next.interface = interfaceYaml;
        else delete next.interface;
        if (Object.keys(next).length) {
            await ensurePlainDirectory(agentsDir);
            await writeFileAtomic(filePath, stringifyYaml(next, { defaultKeyType: "PLAIN", defaultStringType: "QUOTE_DOUBLE" }));
        } else {
            await fs.unlink(filePath).catch((error) => {
                if (nodeErrorCode(error) !== "ENOENT") throw error;
            });
        }
    }
}

async function readOpenAi(filePath: string, expectedName: string): Promise<OpenAiDocument> {
    const entry = await lstatOptional(filePath);
    if (!entry) return { raw: "", data: {} };
    const raw = await fs.readFile(filePath, "utf8");
    let data: Record<string, unknown>;
    try {
        const parsed = parseYaml(raw);
        if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("invalid document");
        data = recordValue(parsed);
    } catch {
        throw new SkillStoreError("agents/openai.yaml 格式无效", 409);
    }
    if (data.interface !== undefined && data.interface !== null && (typeof data.interface !== "object" || Array.isArray(data.interface))) {
        throw new SkillStoreError("agents/openai.yaml interface 格式无效", 409);
    }
    const value = data.interface as Record<string, unknown> | null | undefined;
    const skillInterface = skillInterfaceValue({ displayName: value?.display_name, shortDescription: value?.short_description, defaultPrompt: value?.default_prompt }, expectedName);
    return { raw, data, ...(skillInterface ? { interface: skillInterface } : {}) };
}

async function restoreSkillFiles(skillFile: string, skillRaw: string, openAiFile: string, openAiRaw: string) {
    try {
        await writeFileAtomic(skillFile, skillRaw);
        if (openAiRaw) {
            await ensurePlainDirectory(path.dirname(openAiFile));
            await writeFileAtomic(openAiFile, openAiRaw);
        } else {
            await fs.unlink(openAiFile).catch((error) => {
                if (nodeErrorCode(error) !== "ENOENT") throw error;
            });
        }
        return true;
    } catch {
        return false;
    }
}
