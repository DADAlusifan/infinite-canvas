import type { RequestHandler } from "express";
import type { CanvasSession } from "../canvas/session.js";

/** Capture scope before awaiting business work; a late response must still identify its original engine. */
export function agentRequestScope(session: CanvasSession): RequestHandler {
    return (req, res, next) => {
        const requestedEngine = /^\/agent\/(codex|dsh)(?:\/|$)/.exec(req.path)?.[1];
        const scoped = requestedEngine || req.path === "/canvas/result";
        const posted = req.method !== "GET" && req.method !== "HEAD";
        if (scoped && ((posted && (!req.query.engineId || !req.query.runtimeId)) || !session.matchesScope({ engineId: requestedEngine || req.query.engineId, runtimeId: req.query.runtimeId }) || (req.query.engineId && !session.matchesScope({ engineId: req.query.engineId })))) {
            return void res.status(409).json({ ok: false, code: "ENGINE_STALE", error: "Agent 引擎或运行实例已切换，请同步后重试", ...session.engineSnapshot });
        }
        if (req.path.startsWith("/agent/")) {
            const captured = session.scope;
            const transition = /^\/agent\/engines\/(?:[^/]+\/activate|dsh\/profile)$/.test(req.path);
            const original = res.json.bind(res);
            res.json = ((value: unknown) => original(value && typeof value === "object" && !Array.isArray(value)
                ? { ...value, ...(transition ? session.scope : captured) } : value)) as typeof res.json;
        }
        next();
    };
}
