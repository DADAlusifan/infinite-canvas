import SuperJSON from "superjson";

export type BinaryRef = { id: string; size: number; type: string };
type BinaryNode = {
    node: object;
    kind: string;
    ref?: BinaryRef;
    buffer?: object;
    byteOffset?: number;
    length?: number;
    name?: string;
    lastModified?: number;
};
type StoredGraph = {
    value: unknown;
    binaries: BinaryNode[];
    nullObjects: object[];
    arrays: { node: unknown[]; keys: string[]; length: number }[];
    regexps: { node: RegExp; lastIndex: number }[];
    collections: { node: object; kind: "Map" | "Set"; entries: unknown[] }[];
};

const typedArrays = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

function assertNoExtraProperties(value: object, allowed: (key: string) => boolean = () => false) {
    if (Object.getOwnPropertyNames(value).some((key) => !allowed(key))) throw new Error("无法保存内置类型上的自定义属性");
}

/** Validate the whole graph before any binary writes, rather than losing unsupported plugin values. */
export function assertStorableValue(value: unknown, seen = new WeakSet<object>()): void {
    if (typeof value === "function" || typeof value === "symbol") throw new Error("无法保存函数或 Symbol 类型的插件数据");
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Object.getOwnPropertySymbols(value).length) throw new Error("无法保存含 Symbol 属性的插件数据");
    if (value instanceof Blob || value instanceof ArrayBuffer) { assertNoExtraProperties(value); return; }
    if (ArrayBuffer.isView(value)) {
        if (!(value.buffer instanceof ArrayBuffer)) throw new Error("不支持共享内存类型的插件数据");
        if (!(value instanceof DataView) && !(value.constructor.name in typedArrays)) throw new Error("不支持该二进制数组类型");
        const Constructor = value instanceof DataView ? DataView : typedArrays[value.constructor.name as keyof typeof typedArrays];
        if (Object.getPrototypeOf(value) !== Constructor.prototype) throw new Error("无法保存自定义二进制数组类型");
        assertNoExtraProperties(value, (key) => !(value instanceof DataView) && /^(0|[1-9]\d*)$/.test(key));
        return;
    }
    if (value instanceof Date) {
        assertNoExtraProperties(value);
        if (!Number.isFinite(value.getTime())) throw new Error("无法保存无效日期");
        return;
    }
    if (value instanceof RegExp || value instanceof URL) { assertNoExtraProperties(value, (key) => value instanceof RegExp && key === "lastIndex"); return; }
    if (value instanceof Map) {
        assertNoExtraProperties(value);
        for (const [key, item] of value) { assertStorableValue(key, seen); assertStorableValue(item, seen); }
        return;
    }
    if (value instanceof Set) {
        assertNoExtraProperties(value);
        for (const item of value) assertStorableValue(item, seen);
        return;
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new Error(`不支持保存 ${value.constructor?.name || "未知"} 类型的插件数据`);
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (Array.isArray(value) && key === "length") continue;
        if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("无法保存访问器或非枚举属性");
        if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error("无法保存数组的自定义属性");
        assertStorableValue(descriptor.value, seen);
    }
}

export async function encodeStoredValue(value: unknown, writeBinary: (blob: Blob) => Promise<BinaryRef>): Promise<string> {
    assertStorableValue(value);
    const graph: StoredGraph = { value: undefined, binaries: [], nullObjects: [], arrays: [], regexps: [], collections: [] };
    const seen = new WeakMap<object, object>();
    const clone = async (item: unknown): Promise<any> => {
        if (item === null || typeof item !== "object") return item;
        if (seen.has(item)) return seen.get(item);
        if (item instanceof Blob || item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
            const node = {};
            seen.set(item, node);
            if (ArrayBuffer.isView(item)) {
                graph.binaries.push({
                    node, kind: item instanceof DataView ? "DataView" : item.constructor.name,
                    buffer: await clone(item.buffer), byteOffset: item.byteOffset,
                    length: item instanceof DataView ? item.byteLength : (item as Uint8Array).length,
                });
            } else {
                const file = typeof File !== "undefined" && item instanceof File ? item : undefined;
                const blob = item instanceof Blob ? item : new Blob([item]);
                graph.binaries.push({
                    node, kind: file ? "File" : item instanceof Blob ? "Blob" : "ArrayBuffer", ref: await writeBinary(blob),
                    ...(file ? { name: file.name, lastModified: file.lastModified } : {}),
                });
            }
            return node;
        }
        if (item instanceof Date || item instanceof URL || item instanceof RegExp) {
            const result = item instanceof Date ? new Date(item) : item instanceof URL ? new URL(item.href) : new RegExp(item.source, item.flags);
            seen.set(item, result);
            if (item instanceof RegExp) graph.regexps.push({ node: result as RegExp, lastIndex: item.lastIndex });
            return result;
        }
        const result = Array.isArray(item) ? new Array(item.length) : {};
        seen.set(item, result);
        if (item instanceof Map) {
            const entries = [];
            graph.collections.push({ node: result, kind: "Map", entries });
            for (const [key, entry] of item) entries.push([await clone(key), await clone(entry)]);
        } else if (item instanceof Set) {
            const entries = [];
            graph.collections.push({ node: result, kind: "Set", entries });
            for (const entry of item) entries.push(await clone(entry));
        } else {
            for (const key of Object.keys(item)) Object.defineProperty(result, key, { value: await clone((item as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
            if (Array.isArray(item)) graph.arrays.push({ node: result as unknown[], keys: Object.keys(item), length: item.length });
            else if (Object.getPrototypeOf(item) === null) graph.nullObjects.push(result);
        }
        return result;
    };
    graph.value = await clone(value);
    return JSON.stringify({ format: "infinite-canvas-value", version: 1, data: SuperJSON.serialize(graph) });
}

function readGraph(encoded: string): StoredGraph {
    const envelope = JSON.parse(encoded);
    if (envelope?.format !== "infinite-canvas-value" || envelope.version !== 1 || !envelope.data) throw new Error("未知的本地数据格式");
    const graph = SuperJSON.deserialize<StoredGraph>(envelope.data);
    if (!graph || !Array.isArray(graph.binaries) || !Array.isArray(graph.arrays) || !Array.isArray(graph.nullObjects) || !Array.isArray(graph.regexps) || !Array.isArray(graph.collections)) throw new Error("本地数据内容损坏");
    for (const entry of graph.binaries) {
        if (!entry.node || typeof entry.node !== "object") throw new Error("二进制引用损坏");
        if (entry.ref && (typeof entry.ref.id !== "string" || !entry.ref.id || !Number.isSafeInteger(entry.ref.size) || entry.ref.size < 0 || typeof entry.ref.type !== "string")) throw new Error("二进制引用损坏");
    }
    return graph;
}

/** Returns structural data without opening large binary objects; used by backup preflight. */
export function inspectStoredValue(encoded: string) {
    const graph = readGraph(encoded);
    return { value: restoreGraph(graph, new WeakMap()), binaries: graph.binaries.flatMap((entry) => entry.ref ? [entry.ref] : []) };
}

export function transformStoredValue(encoded: string, transform: (value: unknown) => unknown): string {
    const graph = readGraph(encoded);
    if (typeof graph.value === "string") graph.value = transform(graph.value);
    // Transform the whole graph so cloning also preserves descriptor-to-value identity.
    return JSON.stringify({ format: "infinite-canvas-value", version: 1, data: SuperJSON.serialize(transform(graph)) });
}

export async function decodeStoredValue<T>(encoded: string, readBinary: (ref: BinaryRef) => Promise<Blob>): Promise<T> {
    const graph = readGraph(encoded);
    const replacements = new WeakMap<object, unknown>();
    for (const entry of graph.binaries) {
        if (!entry.ref) continue;
        const blob = await readBinary(entry.ref);
        if (!(blob instanceof Blob) || blob.size !== entry.ref.size) throw new Error(`本地二进制文件缺失或损坏：${entry.ref.id}`);
        if (entry.kind === "ArrayBuffer") replacements.set(entry.node, await blob.arrayBuffer());
        else if (entry.kind === "File") replacements.set(entry.node, new File([blob], entry.name || "", { type: entry.ref.type, lastModified: entry.lastModified }));
        else if (entry.kind === "Blob") replacements.set(entry.node, blob.slice(0, blob.size, entry.ref.type));
        else throw new Error("未知的二进制数据类型");
    }
    for (const entry of graph.binaries) {
        if (entry.ref) continue;
        const buffer = entry.buffer && replacements.get(entry.buffer);
        if (!(buffer instanceof ArrayBuffer) || !Number.isSafeInteger(entry.byteOffset) || !Number.isSafeInteger(entry.length)) throw new Error("二进制数组引用损坏");
        if (entry.kind === "DataView") replacements.set(entry.node, new DataView(buffer, entry.byteOffset, entry.length));
        else {
            const Constructor = typedArrays[entry.kind as keyof typeof typedArrays];
            if (!Constructor) throw new Error("未知的二进制数组类型");
            replacements.set(entry.node, new Constructor(buffer, entry.byteOffset, entry.length));
        }
    }
    return restoreGraph(graph, replacements) as T;
}

function restoreGraph(graph: StoredGraph, replacements: WeakMap<object, unknown>): unknown {
    // Encode collections as explicit nodes: mutating Set entries while applying identity
    // metadata can reorder indexes, losing identity when several members are shared.
    for (const entry of graph.collections) {
        if (entry.kind !== "Map" && entry.kind !== "Set") throw new Error("未知的集合类型");
        replacements.set(entry.node, entry.kind === "Map" ? new Map() : new Set());
    }
    for (const item of graph.nullObjects) Object.setPrototypeOf(item, null);
    for (const { node, keys, length } of graph.arrays) {
        const present = new Set(keys);
        for (const key of Object.keys(node)) if (!present.has(key)) Reflect.deleteProperty(node, key);
        node.length = length;
    }
    for (const { node, lastIndex } of graph.regexps) node.lastIndex = lastIndex;
    const seen = new WeakSet<object>();
    const restore = (item: any): any => {
        if (!item || typeof item !== "object") return item;
        if (replacements.has(item)) return replacements.get(item);
        if (seen.has(item)) return item;
        seen.add(item);
        if (item instanceof Map) {
            const entries = [...item]; item.clear();
            for (const [key, value] of entries) item.set(restore(key), restore(value));
        } else if (item instanceof Set) {
            const entries = [...item]; item.clear();
            for (const value of entries) item.add(restore(value));
        } else if (!(item instanceof Date || item instanceof URL || item instanceof RegExp)) {
            for (const key of Object.keys(item)) Object.defineProperty(item, key, { value: restore(item[key]), enumerable: true, writable: true, configurable: true });
        }
        return item;
    };
    for (const entry of graph.collections) {
        const collection = replacements.get(entry.node);
        if (collection instanceof Map) for (const [key, value] of entry.entries as [unknown, unknown][]) collection.set(restore(key), restore(value));
        else if (collection instanceof Set) for (const value of entry.entries) collection.add(restore(value));
    }
    return restore(graph.value);
}
