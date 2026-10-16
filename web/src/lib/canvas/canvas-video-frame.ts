import i18n from "@/i18n";
import { getMediaBlob } from "@/services/file-storage";
import { desktopBlobUrl, isDesktop } from "@/services/desktop/runtime";
import { withLocalProxy } from "@/stores/use-config-store";

export type VideoFramePosition = "first" | "last" | "current";

const frameError = (key: string) => new Error(i18n.t(`canvas.videoFrames.${key}`));
const isSecurityError = (error: unknown) => error instanceof DOMException && error.name === "SecurityError";

export async function captureVideoFrame(source: string, position: VideoFramePosition, currentTime: number, options: { storageKey?: string; player?: HTMLVideoElement } = {}) {
    const player = options.player;
    if (position === "current" && player && !player.seeking && player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
            return await exportFrame(player);
        } catch (error) {
            // A remote player may be viewable but not canvas-readable; retry through the configured source below.
            if (!isSecurityError(error)) throw error;
        }
    }

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let objectUrl: string | undefined;
    try {
        const nativeUrl = isDesktop() && options.storageKey ? desktopBlobUrl("media_files", options.storageKey) : undefined;
        const blob = options.storageKey && !nativeUrl ? await getMediaBlob(options.storageKey) : null;
        if (blob) objectUrl = URL.createObjectURL(blob);
        await waitForVideo(video, "loadeddata", () => {
            video.src = nativeUrl || objectUrl || withLocalProxy(source);
            video.load();
        });

        if (!Number.isFinite(video.duration) || video.duration <= 0) throw frameError("notReady");
        const endTime = Math.max(0, video.duration - 0.001);
        const time = position === "first" ? 0 : position === "last" ? endTime : Math.max(0, Math.min(currentTime, endTime));
        if (video.currentTime !== time) {
            await waitForVideo(video, "seeked", () => { video.currentTime = time; });
        }
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitForVideo(video, "loadeddata");

        return await exportFrame(video);
    } catch (error) {
        if (isSecurityError(error)) throw frameError("crossOrigin");
        throw error;
    } finally {
        video.removeAttribute("src");
        video.load();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}

function exportFrame(video: HTMLVideoElement) {
    if (!video.videoWidth || !video.videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) throw frameError("notReady");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw frameError("failed");
    context.drawImage(video, 0, 0);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(frameError("failed"))), "image/png"));
}

function waitForVideo(video: HTMLVideoElement, eventName: "loadeddata" | "seeked", start?: () => void) {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
        };
        const finish = () => {
            cleanup();
            resolve();
        };
        const fail = () => {
            cleanup();
            reject(frameError(video.error?.code === MediaError.MEDIA_ERR_DECODE ? "decodeFailed" : "readFailed"));
        };
        video.addEventListener(eventName, finish);
        video.addEventListener("error", fail);
        try {
            if (video.error) fail();
            else start?.();
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}
