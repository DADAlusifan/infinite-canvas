import { startStorageActivity } from "@/services/storage/maintenance";

export type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
    finishActivity: () => void;
};

type Requests = Map<string, CanvasGenerationRequest>;

export function startCanvasGenerationRequest(requests: Requests, targetNodeId: string, originNodeId: string, runningNodeId = originNodeId, controller = new AbortController()) {
    const previous = requests.get(targetNodeId);
    if (previous?.controller === controller) return controller;
    const finishActivity = startStorageActivity();
    // Register the replacement before aborting the old request. Its old finally
    // must not release the replacement, nor expose a false idle interval.
    requests.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId, controller, finishActivity });
    if (previous) { previous.controller.abort(); previous.finishActivity(); }
    return controller;
}

export function finishCanvasGenerationRequest(requests: Requests, targetNodeId: string, controller: AbortController) {
    const request = requests.get(targetNodeId);
    if (request?.controller !== controller) return;
    requests.delete(targetNodeId);
    request.finishActivity();
}

export function stopCanvasGenerationRequests(requests: Requests, runningNodeId?: string) {
    const affected = new Set<string>();
    for (const request of [...requests.values()]) {
        if (runningNodeId !== undefined && request.runningNodeId !== runningNodeId) continue;
        request.controller.abort();
        finishCanvasGenerationRequest(requests, request.targetNodeId, request.controller);
        affected.add(request.targetNodeId);
        affected.add(request.originNodeId);
    }
    return affected;
}
