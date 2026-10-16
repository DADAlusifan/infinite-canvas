import { desktopInvoke, isDesktop } from "@/services/desktop/runtime";

type MaintenanceState = { busy: boolean; label: string; activities: number };
type FlushHandler = () => void | Promise<void>;
const flushHandlers = new Map<FlushHandler, number>();
const pending = new Set<Promise<unknown>>();
const activities = new Set<symbol>();
const listeners = new Set<() => void>();
const blockers = new Set<() => boolean>();
let state: MaintenanceState = { busy: false, label: "", activities: 0 };
let lease: string | undefined;
let flushing = false;
let writeTail: Promise<unknown> = Promise.resolve();
let retryJournal: Array<() => Promise<unknown>> | null = null;

/** A rejected operation has no valid write to recover (for example, a media-key conflict). */
export class StorageWriteRejected extends Error {}

function rejectedWrite(error: unknown) {
    return error instanceof StorageWriteRejected || (error instanceof DOMException && error.name === "DataCloneError");
}

export const getMaintenanceState = () => state;
export const getMaintenanceLease = () => lease;
export function subscribeMaintenance(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(patch: Partial<MaintenanceState>) { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); }

export function registerStorageFlusher(handler: FlushHandler, priority = 0) {
    flushHandlers.set(handler, priority);
    return () => { flushHandlers.delete(handler); };
}

export function registerMaintenanceBlocker(read: () => boolean) {
    blockers.add(read);
    return () => { blockers.delete(read); };
}

export function startStorageActivity() {
    if (state.busy) throw new Error("数据维护中，请完成后再操作");
    const id = Symbol();
    activities.add(id);
    publish({ activities: activities.size });
    return () => { activities.delete(id); publish({ activities: activities.size }); };
}

export async function withStorageActivity<T>(work: () => Promise<T>) {
    const finish = startStorageActivity();
    try { return await work(); } finally { finish(); }
}

async function withBrowserLock<T>(mode: "shared" | "exclusive", work: () => Promise<T>) {
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("infinite-canvas:storage", { mode }, work);
    return work();
}

export function queueStorageWrite<T>(work: () => Promise<T>, prepare?: () => void | Promise<void>): Promise<T> {
    if (state.busy && !flushing) return Promise.reject(new Error("数据维护中，写入已暂停"));
    const execute = async () => {
        // Validate and serialize in enqueue order, before entering the recoverable IO journal.
        await prepare?.();
        try {
            const result = await work();
            if (retryJournal) retryJournal.push(work);
            return result;
        } catch (error) {
            if (!rejectedWrite(error)) (retryJournal ??= []).push(work);
            throw error;
        }
    };
    const result = writeTail.then(() => isDesktop() ? execute() : withBrowserLock("shared", execute));
    writeTail = result.catch(() => undefined);
    pending.add(result);
    void result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
}

export async function flushStorage() {
    flushing = true;
    let handlerError: unknown;
    try {
        for (const [handler] of [...flushHandlers].sort((a, b) => a[1] - b[1])) {
            try { await handler(); } catch (error) { handlerError = error; }
        }
        while (pending.size) await Promise.allSettled([...pending]);
        if (retryJournal) {
            const journal = retryJournal;
            // Replay the failed write and every later write in order, so an old
            // failed snapshot cannot overwrite a newer successful snapshot.
            const replay = writeTail.then(async () => {
                let rejected: unknown;
                while (journal.length) {
                    try { await (isDesktop() ? journal[0]() : withBrowserLock("shared", journal[0])); }
                    catch (error) {
                        if (!rejectedWrite(error)) throw error;
                        rejected ??= error;
                    }
                    journal.shift();
                }
                if (retryJournal === journal) retryJournal = null;
                if (rejected) throw rejected;
            });
            writeTail = replay.catch(() => undefined);
            await replay;
        }
        if (handlerError) throw handlerError;
        if (isDesktop()) await desktopInvoke("desktop_storage_flush");
    } finally { flushing = false; }
}

function freezeStorage(label: string) {
    if (state.busy) throw new Error("数据维护尚未完成，请先完成或取消操作");
    publish({ busy: true, label });
    return () => publish({ busy: false, label: "" });
}

/** The caller has confirmed stopping existing tasks; prevent new work until the host exits. */
export async function withStorageShutdown(label: string, close: () => Promise<void>): Promise<void> {
    const release = freezeStorage(label);
    try {
        await flushStorage();
        await close();
        // A successful close IPC only schedules native destruction. Releasing now
        // would permit new edits or a directory move before the window disappears.
        await new Promise<never>(() => {});
    } finally { release(); }
}

export async function withStorageMaintenance<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (activities.size || [...blockers].some((read) => read())) throw new Error("请先等待生成、对话、同步或文件操作完成，再进行数据维护");
    const release = freezeStorage(label);
    try {
        await flushStorage();
        const run = async () => {
            if (isDesktop()) lease = (await desktopInvoke<{ token: string }>("desktop_maintenance_begin")).token;
            try { return await work(); }
            finally {
                if (lease) { const token = lease; lease = undefined; await desktopInvoke("desktop_maintenance_end", { token }); }
            }
        };
        return isDesktop() ? await run() : await withBrowserLock("exclusive", run);
    } finally { release(); }
}
