import { Alert, App, Button, Progress, Spin, theme } from "antd";
import { Download, FolderInput, RotateCcw, X } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { createDesktopSaveTarget } from "@/services/desktop/files";
import { restartDesktopToDataRoot } from "@/services/desktop/data-root";
import { desktopInvoke, isDesktop } from "@/services/desktop/runtime";
import { exportFullBackup } from "@/services/storage/backup";
import { applicationBackupSource } from "@/services/storage/backup-source";
import type { BackupProgress } from "@/services/storage/backup-types";
import { getMaintenanceState, subscribeMaintenance, withStorageMaintenance } from "@/services/storage/maintenance";

type ImportedBackup = { token: string; dataRoot: string; records: number; blobs: number; bytes: number };
type Operation = "export" | "import" | "switch" | null;

export function formatDesktopBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function StorageBackupControls() {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const { token } = theme.useToken();
    const desktop = isDesktop();
    const maintenance = useSyncExternalStore(subscribeMaintenance, getMaintenanceState, getMaintenanceState);
    const [operation, setOperation] = useState<Operation>(null);
    const [progress, setProgress] = useState<BackupProgress | null>(null);
    const [error, setError] = useState("");
    const [canceling, setCanceling] = useState(false);
    const [imported, setImported] = useState<ImportedBackup | null>(null);
    const controller = useRef<AbortController | null>(null);
    const inFlight = useRef(false);

    const reportError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));

    const exportBackup = async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        const abort = new AbortController();
        controller.current = abort;
        setOperation("export");
        setProgress(null);
        setError("");
        try {
            const target = desktop ? await createDesktopSaveTarget("infinite-canvas-backup.zip") : undefined;
            if (target === null) return;
            const result = await exportFullBackup(applicationBackupSource, target, setProgress, abort.signal);
            message.success(t("desktop.backup.exported", { records: result.counts.records, files: result.counts.binaries }));
        } catch (reason) {
            if (abort.signal.aborted && (reason === abort.signal.reason || reason instanceof DOMException && reason.name === "AbortError")) message.info(t("desktop.backup.canceled"));
            else reportError(reason);
        } finally {
            controller.current = null;
            inFlight.current = false;
            setOperation(null);
            setCanceling(false);
        }
    };

    const confirmSwitch = (result: ImportedBackup) => {
        const confirmation = modal.confirm({
            title: t("desktop.backup.switchTitle"),
            content: (
                <div className="space-y-2">
                    <p>{t("desktop.backup.switchDescription", { records: result.records, files: result.blobs, bytes: formatDesktopBytes(result.bytes) })}</p>
                    <p className="break-all font-mono text-xs">{result.dataRoot}</p>
                    <p>{t("desktop.backup.switchHint")}</p>
                </div>
            ),
            okText: t("desktop.backup.switch"), cancelText: t("desktop.backup.later"),
            async onOk() {
                setOperation("switch");
                setError("");
                confirmation.update({ cancelButtonProps: { disabled: true }, keyboard: false });
                try {
                    await withStorageMaintenance(t("desktop.backup.switching"), async () => {
                        await restartDesktopToDataRoot(result.token);
                    });
                } catch (reason) { reportError(reason); throw reason; }
                finally {
                    setOperation(null);
                    confirmation.update({ cancelButtonProps: { disabled: false }, keyboard: true });
                }
            },
        });
    };

    const importBackup = async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        const abort = new AbortController();
        controller.current = abort;
        setOperation("import");
        setProgress(null);
        setError("");
        try {
            await desktopInvoke("desktop_import_cancel");
            setImported(null);
            const result = await withStorageMaintenance(t("desktop.backup.maintaining"), async () => {
                abort.signal.throwIfAborted();
                const ready = await desktopInvoke<ImportedBackup | null>("desktop_import_backup");
                abort.signal.throwIfAborted();
                return ready;
            });
            if (result) { setImported(result); confirmSwitch(result); }
        } catch (reason) {
            const detail = reason instanceof Error ? reason.message : String(reason);
            if (abort.signal.aborted || detail.startsWith("已取消导入") || detail.startsWith("导入已取消")) message.info(t("desktop.backup.canceled"));
            else reportError(reason);
        } finally {
            inFlight.current = false;
            controller.current = null;
            setOperation(null);
            setCanceling(false);
        }
    };

    const cancel = async () => {
        setCanceling(true);
        try {
            controller.current?.abort(new DOMException("Aborted", "AbortError"));
            if (operation === "import") await desktopInvoke("desktop_import_cancel");
        } catch (reason) { reportError(reason); setCanceling(false); }
    };

    const discardReady = async () => {
        try {
            await desktopInvoke("desktop_import_cancel");
            setImported(null);
        } catch (reason) { reportError(reason); }
    };

    const disabled = Boolean(operation) || maintenance.busy || maintenance.activities > 0;
    return (
        <section data-storage-maintenance-controls className="rounded-lg border p-4" style={{ borderColor: token.colorBorderSecondary }}>
            <div className="text-sm font-semibold">{t("desktop.backup.title")}</div>
            <p className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>{t("desktop.backup.description")}</p>
            <Alert className="mt-3" type="info" showIcon title={t("desktop.backup.credentials")} />
            <p className="mt-3 text-xs" style={{ color: token.colorTextSecondary }}>{t(desktop ? "desktop.backup.desktopHint" : "desktop.backup.browserHint")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
                <Button icon={<Download className="size-4" />} disabled={disabled} onClick={() => void exportBackup()}>{t("desktop.backup.export")}</Button>
                {desktop ? <Button icon={<FolderInput className="size-4" />} disabled={disabled} onClick={() => void importBackup()}>{t("desktop.backup.import")}</Button> : null}
                {operation === "export" || operation === "import" ? (
                    <Button type="text" icon={<X className="size-4" />} loading={canceling} onClick={() => void cancel()}>{t(canceling ? "desktop.backup.canceling" : "desktop.backup.cancel")}</Button>
                ) : null}
            </div>
            {operation ? (
                <div className="mt-3" aria-live="polite">
                    <div className="flex items-center gap-2 text-xs">
                        <Spin size="small" />
                        {t(operation === "import" ? "desktop.backup.importing" : operation === "switch" ? "desktop.backup.switching" : `desktop.backup.${progress?.stage || "preflight"}`)}
                    </div>
                    {operation === "export" && progress && progress.total > 0 ? <Progress className="mt-2" size="small" percent={Math.round(progress.completed / progress.total * 100)} /> : null}
                </div>
            ) : null}
            {error ? <Alert className="mt-3" type="error" showIcon title={t("desktop.backup.operationFailed")} description={error} /> : null}
            {imported && !operation ? (
                <Alert className="mt-3" type="success" showIcon title={t("desktop.backup.ready")} description={<span className="break-all font-mono text-xs">{imported.dataRoot}</span>} action={
                    <div className="flex flex-wrap gap-1">
                        <Button type="text" icon={<RotateCcw className="size-4" />} disabled={disabled} onClick={() => confirmSwitch(imported)}>{t("desktop.backup.switchReady")}</Button>
                        <Button type="text" icon={<X className="size-4" />} disabled={disabled} onClick={() => void discardReady()}>{t("desktop.backup.discardReady")}</Button>
                    </div>
                } />
            ) : null}
        </section>
    );
}
