import { Context } from "@deepseek-ai/cordis";
import { installConnection, type ConnectionWebSocket } from "@deepseek-ai/dsh-client-connection/client";
import * as registry from "@deepseek-ai/dsh-typert-registry/client";
import * as gateway from "@deepseek-ai/dsh-api-gateway/client";
import sessionRemote from "@deepseek-ai/dsh-api-session-controller/remote";
import workspaceRemote from "@deepseek-ai/dsh-api-workspace-controller/remote";
import settingsRemote from "@deepseek-ai/dsh-api-settings-controller/remote";
import permissionsRemote from "@deepseek-ai/dsh-permission-presets/remote";
import commandsRemote from "@deepseek-ai/dsh-commands/remote";
import type {} from "@deepseek-ai/dsh-api-remotes";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { typertOwnedValue } from "@deepseek-ai/dsh-typert-protocol";
import WebSocket from "ws";
import type { DshAddress } from "./owned-runtime.js";

/** A fresh /connect exchange is mandatory for every socket Peer, including reconnects. */
export async function exchangeDshConnection(address: DshAddress, doFetch: typeof fetch = fetch) {
    const url = new URL("/connect", address.url);
    url.searchParams.set("token", address.token);
    url.searchParams.set("interactions", "answer");
    const response = await doFetch(url, { redirect: "manual" });
    if (response.status !== 302) throw new Error(`DSH 连接交换失败 (${response.status})`);
    const location = response.headers.get("location");
    const cookies = response.headers.getSetCookie();
    if (!location || !cookies.length) throw new Error("DSH 连接交换缺少 Cookie 或重定向地址");
    const mux = new URL(location, url);
    if (mux.origin !== new URL(address.url).origin || mux.pathname !== "/api/remote.mux") throw new Error("DSH 连接返回了无效的通道地址");
    return { cookie: cookies.map((cookie) => cookie.split(";", 1)[0]).join("; "), mux };
}

/** Adapts only the physical async authentication boundary; official packages own all frames. */
export class AuthenticatedSocket implements ConnectionWebSocket {
    private events = new EventTarget();
    private socket?: WebSocket;
    private closed = false;
    get readyState() { return this.socket?.readyState ?? (this.closed ? 3 : 0); }
    constructor(address: DshAddress, authenticated: (cookie: string) => void, failed: (error: Error) => void) {
        void exchangeDshConnection(address).then(({ cookie, mux }) => {
            if (this.closed) return;
            authenticated(cookie);
            mux.protocol = "ws:";
            const socket = this.socket = new WebSocket(mux, { headers: { Cookie: cookie } });
            socket.addEventListener("open", () => this.events.dispatchEvent(new Event("open")));
            socket.addEventListener("message", (event) => this.events.dispatchEvent(new MessageEvent("message", { data: event.data })));
            socket.addEventListener("close", () => this.events.dispatchEvent(new Event("close")));
            socket.addEventListener("error", () => this.events.dispatchEvent(new Event("error")));
        }).catch((error) => {
            if (this.closed) return;
            this.closed = true;
            failed(error instanceof Error ? error : new Error(String(error)));
            this.events.dispatchEvent(new Event("error"));
            this.events.dispatchEvent(new Event("close"));
        });
    }
    addEventListener: ConnectionWebSocket["addEventListener"] = (event, listener, options) => this.events.addEventListener(event, listener as unknown as EventListener, options);
    removeEventListener: ConnectionWebSocket["removeEventListener"] = (event, listener) => this.events.removeEventListener(event, listener as unknown as EventListener);
    send(data: string) { this.socket?.send(data); }
    close(code?: number, reason?: string) {
        this.closed = true;
        if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.terminate();
        else this.socket?.close(code, reason);
    }
}

/** Node-only BFF composition; no browser session-controller/client is mounted. */
export async function createDshConnection(address: DshAddress) {
    const ctx = new Context();
    let cookie = "";
    let rejectOpening: (error: Error) => void = () => undefined;
    const openingFailed = new Promise<never>((_resolve, reject) => { rejectOpening = reject; });
    await ctx.plugin(registry);
    installConnection(ctx, {
        interactions: "answer",
        transport: {
            fetch: (input, init) => {
                const headers = new Headers(init.headers);
                if (cookie) headers.set("Cookie", cookie);
                return fetch(new URL(input, address.url), { ...init, headers, redirect: "manual" });
            },
            createWebSocket: () => new AuthenticatedSocket(address, (next) => { cookie = next; }, rejectOpening),
            streamBaseUrl: address.url,
        },
    });
    await ctx.plugin(gateway);
    // Waterfall Agent payloads are real Client Contexts associated with native IDs.
    const identities = new WeakMap<Context, SessionId>();
    ctx.typert.contexts.registerClient("agent", {
        identity: (scope) => identities.get(scope),
        resolve: (id) => {
            const scope = ctx.extend();
            identities.set(scope, id);
            return typertOwnedValue(scope, () => { identities.delete(scope); });
        },
    });
    for (const remote of [sessionRemote, workspaceRemote, settingsRemote, permissionsRemote, commandsRemote]) await ctx.remote.$mount(remote);
    const connected = new Promise<void>((resolve) => {
        const ready = () => { if (ctx.connection.generation.getSnapshot()) { off(); resolve(); } };
        const off = ctx.connection.generation.subscribe(ready);
        ready();
    });
    try { await Promise.race([connected, openingFailed]); }
    catch (error) { await ctx.fiber.dispose(); throw error; }
    return { ctx, sessionIdOf: (scope: Context) => identities.get(scope), close: () => ctx.fiber.dispose() };
}

export function unwrapDsh<T>(result: { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }): T {
    if (result.ok) return result.value;
    throw Object.assign(new Error(result.error.message), { code: result.error.code });
}
