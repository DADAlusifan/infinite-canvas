import i18n from "@/i18n";

export function normalizeImageSizeOption(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim().toLowerCase();
    if (text === "auto") return text;
    const match = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(text);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
    return `${width}x${height}`;
}

export function normalizeModelImageSizes(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error(i18n.t("modelImageSizes.invalidList"));
    const sizes = new Set<string>();
    value.forEach((item, index) => {
        if (typeof item === "string" && !item.trim()) return;
        const size = normalizeImageSizeOption(item);
        if (!size) throw new Error(i18n.t("modelImageSizes.invalidLine", { line: index + 1 }));
        sizes.add(size);
    });
    return sizes.size ? [...sizes] : undefined;
}

export function parseModelImageSizes(text: string): string[] | undefined {
    return normalizeModelImageSizes(text.split(/\r?\n/));
}

export function isModelImageSizeSupported(sizes: string[], size: string): boolean {
    const normalized = normalizeImageSizeOption(size.trim() || "auto");
    return normalized !== null && sizes.includes(normalized);
}

export function formatModelImageSize(size: string): string {
    const normalized = normalizeImageSizeOption(size.trim() || "auto");
    if (normalized === "auto") return i18n.t("settingsPanels.common.auto");
    return (normalized || size).replace("x", " × ");
}
