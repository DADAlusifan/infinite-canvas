import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MIN_SHORT_DESCRIPTION_LENGTH = 25;
const MAX_SHORT_DESCRIPTION_LENGTH = 64;
const MAX_DEFAULT_PROMPT_LENGTH = 1024;

export type ManagedSkillInterface = {
    displayName?: string;
    shortDescription?: string;
    defaultPrompt?: string;
};

export type CreateManagedSkillInput = {
    name: string;
    description: string;
    instructions: string;
    interface?: ManagedSkillInterface | null;
};

export type UpdateManagedSkillInput = {
    description: string;
    instructions: string;
    interface?: ManagedSkillInterface | null;
    expectedRevision: string;
};

export type SkillDocument = {
    raw: string;
    frontmatter: Record<string, unknown>;
    description: string;
    instructions: string;
};

export class SkillStoreError extends Error {
    override name = "SkillStoreError";
    constructor(message: string, readonly statusCode: 400 | 404 | 409 | 500) {
        super(message);
    }
}

export function validName(value: string | undefined): value is string {
    return Boolean(value && value.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(value));
}

export function skillName(value: unknown) {
    const name = typeof value === "string" ? value : "";
    if (!validName(name)) throw new SkillStoreError("Skill 名称只能包含小写字母、数字和连字符", 400);
    return name;
}

export function skillDescription(value: unknown) {
    const description = typeof value === "string" ? value.trim() : "";
    if (!description) throw new SkillStoreError("请输入 Skill 描述", 400);
    if (description.length > MAX_DESCRIPTION_LENGTH) throw new SkillStoreError("Skill 描述过长", 400);
    if (description.includes("<") || description.includes(">")) throw new SkillStoreError("Skill 描述不能包含尖括号", 400);
    return description;
}

export function skillInstructions(value: unknown) {
    const instructions = typeof value === "string" ? value.trim() : "";
    if (!instructions) throw new SkillStoreError("请输入 Skill 正文", 400);
    if (Buffer.byteLength(instructions, "utf8") > MAX_INSTRUCTIONS_BYTES) throw new SkillStoreError("Skill 正文不能超过 256KiB", 400);
    return instructions;
}

export function skillInterfaceValue(value: unknown, name: string, marker: "$" | "/" = "$"): ManagedSkillInterface | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw new SkillStoreError("Skill 界面元数据无效", 400);
    const interfaceValue = value as Record<string, unknown>;
    const displayName = optionalText(interfaceValue.displayName, "显示名称", MAX_DISPLAY_NAME_LENGTH);
    const shortDescription = optionalText(interfaceValue.shortDescription, "简短描述", MAX_SHORT_DESCRIPTION_LENGTH);
    const defaultPrompt = optionalText(interfaceValue.defaultPrompt, "默认提示词", MAX_DEFAULT_PROMPT_LENGTH);
    if (shortDescription && shortDescription.length < MIN_SHORT_DESCRIPTION_LENGTH) throw new SkillStoreError(`简短描述不能少于 ${MIN_SHORT_DESCRIPTION_LENGTH} 个字符`, 400);
    if (defaultPrompt && !mentionsSkill(defaultPrompt, name, marker)) throw new SkillStoreError(`默认提示词必须包含 ${marker}${name}`, 400);
    return displayName || shortDescription || defaultPrompt ? { ...(displayName ? { displayName } : {}), ...(shortDescription ? { shortDescription } : {}), ...(defaultPrompt ? { defaultPrompt } : {}) } : undefined;
}

export function optionalText(value: unknown, label: string, maxLength: number) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new SkillStoreError(`${label}格式无效`, 400);
    const text = value.trim();
    if (text.length > maxLength) throw new SkillStoreError(`${label}过长`, 400);
    return text || undefined;
}

export function expectedRevisionValue(value: unknown) {
    const expected = typeof value === "string" ? value : "";
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new SkillStoreError("Skill revision 无效，请重新加载后再试", 400);
    return expected;
}

export function assertRevision(expected: string, current: string) {
    if (expected !== current) throw new SkillStoreError("Skill 已被其他窗口或外部编辑器修改，请重新加载后再试", 409);
}

export function serializeSkill(frontmatter: Record<string, unknown>, instructions: string) {
    return matter.stringify(`${instructions.trim()}\n`, frontmatter);
}

export async function readSkill(filePath: string, expectedName: string): Promise<SkillDocument> {
    const raw = await fs.readFile(filePath, "utf8");
    let parsed: matter.GrayMatterFile<string>;
    try {
        parsed = matter(raw);
    } catch {
        throw new SkillStoreError("SKILL.md frontmatter 格式无效", 409);
    }
    const frontmatter = recordValue(parsed.data);
    if (frontmatter.name !== expectedName) throw new SkillStoreError("SKILL.md 中的名称与目录不一致", 409);
    return {
        raw,
        frontmatter,
        description: skillDescription(frontmatter.description),
        instructions: skillInstructions(parsed.content),
    };
}

export function mentionsSkill(prompt: string, name: string, marker: "$" | "/" = "$") {
    const pattern = marker === "$"
        ? `\\$${name}(?![A-Za-z0-9_-]|:[A-Za-z0-9_-])`
        : `(?:^|[\\s(（])/${name}(?![A-Za-z0-9_:/-]|\\.[A-Za-z0-9])`;
    return new RegExp(pattern).test(prompt);
}

export async function writeFileAtomic(filePath: string, content: string) {
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
        await fs.rename(temporary, filePath);
    } finally {
        await fs.unlink(temporary).catch((error) => {
            if (nodeErrorCode(error) !== "ENOENT") throw error;
        });
    }
}

export function revision(skillRaw: string, openAiRaw: string) {
    return crypto.createHash("sha256").update(skillRaw).update("\0").update(openAiRaw).digest("hex");
}

export async function ensurePlainDirectory(directory: string) {
    const entry = await lstatOptional(directory);
    if (!entry) {
        await fs.mkdir(directory);
        return;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new SkillStoreError("Skill 路径中存在符号链接或目录联接", 400);
}

export async function assertTreeHasNoLinks(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        const metadata = await fs.lstat(entryPath);
        if (metadata.isSymbolicLink()) throw new SkillStoreError("Skill 目录中存在符号链接或目录联接，无法删除", 400);
        if (metadata.isDirectory()) await assertTreeHasNoLinks(entryPath);
    }
}

export function inside(parent: string, child: string) {
    const relative = path.relative(parent, child);
    return Boolean(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function lstatOptional(filePath: string) {
    try {
        return await fs.lstat(filePath);
    } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") return undefined;
        throw error;
    }
}

export function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export function nodeErrorCode(error: unknown) {
    return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}

export function storeError(error: unknown, fallback: string) {
    if (error instanceof SkillStoreError) return error;
    if (nodeErrorCode(error) === "ENOENT") return new SkillStoreError("找不到指定 Skill", 404);
    if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(nodeErrorCode(error))) return new SkillStoreError("Skill 文件当前无法修改", 409);
    return new SkillStoreError(fallback, 500);
}
