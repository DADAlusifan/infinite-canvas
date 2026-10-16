import fs from "node:fs/promises";
import path from "node:path";

import { SkillStoreError, ensurePlainDirectory, inside, lstatOptional, skillName, storeError, validName } from "./document.js";

/** 两种原生 Skill 格式共同使用的写入队列和路径边界。 */
export class SkillFiles {
    readonly workspacePath: string;
    readonly skillsPath: string;
    protected writeQueue: Promise<unknown> = Promise.resolve();
    private readonly namespacePath: string;

    constructor(workspacePath: string, namespace: ".agents" | ".dsh") {
        this.workspacePath = path.resolve(workspacePath);
        this.namespacePath = path.join(this.workspacePath, namespace);
        this.skillsPath = path.join(this.namespacePath, "skills");
    }

    isManagedPath(filePath: string) {
        if (!path.isAbsolute(filePath)) return false;
        const relative = path.relative(this.skillsPath, path.resolve(filePath));
        const segments = relative.split(path.sep);
        return segments.length === 2 && validName(segments[0]) && segments[1].toLowerCase() === "skill.md";
    }

    protected mutate<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.writeQueue.catch(() => undefined).then(operation).catch((error) => { throw storeError(error, "修改 Skill 失败"); });
        this.writeQueue = result.catch(() => undefined);
        return result;
    }

    protected async ensureRoot() {
        const workspace = await lstatOptional(this.workspacePath);
        if (!workspace) throw new SkillStoreError("站点工作空间不存在", 409);
        if (workspace.isSymbolicLink()) throw new SkillStoreError("站点工作空间不能是符号链接或目录联接", 400);
        if (!workspace.isDirectory()) throw new SkillStoreError("站点工作空间不是目录", 409);
        await ensurePlainDirectory(this.namespacePath);
        await ensurePlainDirectory(this.skillsPath);
        await this.assertRootInsideWorkspace();
    }

    protected async assertExistingRoot() {
        const workspace = await lstatOptional(this.workspacePath);
        if (!workspace) throw new SkillStoreError("找不到指定 Skill", 404);
        if (workspace.isSymbolicLink()) throw new SkillStoreError("站点工作空间不能是符号链接或目录联接", 400);
        if (!workspace.isDirectory()) throw new SkillStoreError("找不到指定 Skill", 404);
        const namespace = await lstatOptional(this.namespacePath);
        const root = await lstatOptional(this.skillsPath);
        if (!namespace || !root) throw new SkillStoreError("找不到指定 Skill", 404);
        if (namespace.isSymbolicLink() || !namespace.isDirectory() || root.isSymbolicLink() || !root.isDirectory()) throw new SkillStoreError("Skill 路径中存在符号链接或目录联接", 400);
        await this.assertRootInsideWorkspace();
    }

    protected async safeExistingPaths(nameValue: string) {
        const name = skillName(nameValue);
        await this.assertExistingRoot();
        const skillDir = path.join(this.skillsPath, name);
        const directory = await lstatOptional(skillDir);
        if (!directory) throw new SkillStoreError("找不到指定 Skill", 404);
        if (directory.isSymbolicLink() || !directory.isDirectory()) throw new SkillStoreError("Skill 目录不安全", 400);
        const realRoot = await fs.realpath(this.skillsPath);
        const realSkill = await fs.realpath(skillDir);
        if (!inside(realRoot, realSkill)) throw new SkillStoreError("Skill 路径不安全", 400);
        const skillFile = path.join(skillDir, "SKILL.md");
        const skillEntry = await lstatOptional(skillFile);
        if (!skillEntry) throw new SkillStoreError("Skill 缺少 SKILL.md", 404);
        if (skillEntry.isSymbolicLink() || !skillEntry.isFile()) throw new SkillStoreError("SKILL.md 路径不安全", 400);
        return { skillDir, skillFile };
    }

    private async assertRootInsideWorkspace() {
        const realWorkspace = await fs.realpath(this.workspacePath);
        const realRoot = await fs.realpath(this.skillsPath);
        if (!inside(realWorkspace, realRoot)) throw new SkillStoreError("Skill 根目录不安全", 400);
    }
}
