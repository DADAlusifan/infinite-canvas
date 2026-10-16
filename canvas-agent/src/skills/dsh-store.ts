import fs from "node:fs/promises";
import path from "node:path";

import { SkillFiles } from "./files.js";
import {
    SkillStoreError, assertRevision, assertTreeHasNoLinks, expectedRevisionValue, inside,
    lstatOptional, readSkill, recordValue, revision, serializeSkill, skillDescription,
    skillInstructions, skillInterfaceValue, skillName, storeError, validName, writeFileAtomic,
    type CreateManagedSkillInput, type ManagedSkillInterface, type SkillDocument, type UpdateManagedSkillInput,
} from "./document.js";

const INTERFACE_KEY = "infinite-canvas";

export type DshManagedSkillDetail = {
    name: string;
    description: string;
    instructions: string;
    interface?: ManagedSkillInterface;
    path: string;
    revision: string;
    managed: true;
    enabled: boolean;
    modelInvocable: boolean;
};

/** DSH 直接读取 SKILL.md；界面字段也随该文档保存，不创建 OpenAI 元数据。 */
export class DshSkillStore extends SkillFiles {
    constructor(workspacePath: string) {
        super(workspacePath, ".dsh");
    }

    async get(nameValue: string): Promise<DshManagedSkillDetail> {
        try {
            await this.writeQueue.catch(() => undefined);
            const name = skillName(nameValue);
            const { skillFile } = await this.safeExistingPaths(name);
            return this.detail(name, skillFile, await readSkill(skillFile, name));
        } catch (error) {
            throw storeError(error, "读取 DSH Skill 失败");
        }
    }

    async list() {
        await this.writeQueue.catch(() => undefined);
        const skills: DshManagedSkillDetail[] = [];
        const errors: Array<{ path: string; message: string }> = [];
        try {
            await this.assertExistingRoot();
        } catch (error) {
            if (error instanceof SkillStoreError && error.statusCode === 404) return { skills, errors };
            throw error;
        }
        for (const entry of await fs.readdir(this.skillsPath, { withFileTypes: true })) {
            if (!validName(entry.name)) continue;
            try {
                skills.push(await this.get(entry.name));
            } catch (error) {
                errors.push({ path: path.join(this.skillsPath, entry.name, "SKILL.md"), message: error instanceof Error ? error.message : "读取 Skill 失败" });
            }
        }
        return { skills, errors };
    }

    create(input: CreateManagedSkillInput) {
        return this.mutate(async () => {
            const name = skillName(input?.name);
            const description = skillDescription(input?.description);
            const instructions = skillInstructions(input?.instructions);
            const skillInterface = skillInterfaceValue(input?.interface, name, "/");
            await this.ensureRoot();
            const skillDir = path.join(this.skillsPath, name);
            const existing = await lstatOptional(skillDir);
            if (existing?.isSymbolicLink()) throw new SkillStoreError("Skill 目录不能是符号链接或目录联接", 400);
            if (existing) throw new SkillStoreError("同名 Skill 已存在", 409);
            await fs.mkdir(skillDir);
            try {
                const skillFile = path.join(skillDir, "SKILL.md");
                const frontmatter = withInterface({ name, description, "disable-model-invocation": false, "user-invocable": true }, skillInterface);
                await writeFileAtomic(skillFile, serializeSkill(frontmatter, instructions));
                return this.detail(name, skillFile, await readSkill(skillFile, name));
            } catch (error) {
                await fs.rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
                throw error;
            }
        });
    }

    update(nameValue: string, input: UpdateManagedSkillInput) {
        return this.mutate(async () => {
            const name = skillName(nameValue);
            const description = skillDescription(input?.description);
            const instructions = skillInstructions(input?.instructions);
            const expected = expectedRevisionValue(input?.expectedRevision);
            const skillInterface = input.interface === undefined ? undefined : skillInterfaceValue(input.interface, name, "/");
            const { skillFile } = await this.safeExistingPaths(name);
            const current = await readSkill(skillFile, name);
            assertRevision(expected, revision(current.raw, ""));
            const frontmatter = { ...current.frontmatter, name, description };
            const next = input.interface === undefined ? frontmatter : withInterface(frontmatter, skillInterface);
            await writeFileAtomic(skillFile, serializeSkill(next, instructions));
            return this.detail(name, skillFile, await readSkill(skillFile, name));
        });
    }

    setEnabled(nameValue: string, enabled: boolean, expectedRevision: string) {
        return this.mutate(async () => {
            const name = skillName(nameValue);
            if (typeof enabled !== "boolean") throw new SkillStoreError("Skill 启用状态无效", 400);
            const expected = expectedRevisionValue(expectedRevision);
            const { skillFile } = await this.safeExistingPaths(name);
            const current = await readSkill(skillFile, name);
            assertRevision(expected, revision(current.raw, ""));
            const frontmatter = { ...current.frontmatter, "disable-model-invocation": !enabled, "user-invocable": enabled };
            await writeFileAtomic(skillFile, serializeSkill(frontmatter, current.instructions));
            return this.detail(name, skillFile, await readSkill(skillFile, name));
        });
    }

    delete(nameValue: string, expectedRevision: string) {
        return this.mutate(async () => {
            const name = skillName(nameValue);
            const expected = expectedRevisionValue(expectedRevision);
            const { skillDir, skillFile } = await this.safeExistingPaths(name);
            const current = await readSkill(skillFile, name);
            assertRevision(expected, revision(current.raw, ""));
            await assertTreeHasNoLinks(skillDir);
            const realRoot = await fs.realpath(this.skillsPath);
            const realSkill = await fs.realpath(skillDir);
            if (!inside(realRoot, realSkill)) throw new SkillStoreError("Skill 路径不安全", 400);
            await fs.rm(realSkill, { recursive: true });
        });
    }

    private detail(name: string, skillFile: string, skill: SkillDocument): DshManagedSkillDetail {
        const skillInterface = skillInterfaceValue(recordValue(skill.frontmatter.metadata)[INTERFACE_KEY], name, "/");
        return {
            name, description: skill.description, instructions: skill.instructions,
            ...(skillInterface ? { interface: skillInterface } : {}),
            path: skillFile, revision: revision(skill.raw, ""), managed: true,
            enabled: skill.frontmatter["user-invocable"] !== false,
            modelInvocable: skill.frontmatter["disable-model-invocation"] !== true,
        };
    }
}

function withInterface(frontmatter: Record<string, unknown>, skillInterface?: ManagedSkillInterface) {
    const metadata = recordValue(frontmatter.metadata);
    const current = recordValue(metadata[INTERFACE_KEY]);
    delete current.displayName;
    delete current.shortDescription;
    delete current.defaultPrompt;
    const next = { ...current, ...skillInterface };
    const result = { ...frontmatter };
    if (Object.keys(next).length) metadata[INTERFACE_KEY] = next;
    else delete metadata[INTERFACE_KEY];
    if (Object.keys(metadata).length) result.metadata = metadata;
    else delete result.metadata;
    return result;
}
