import { Alert, App, Button, Collapse, Dropdown, Spin, Table, theme } from "antd";
import { Database, FolderInput, FolderOpen, RefreshCw, ScanLine, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { desktopInvoke, getDesktopRuntime } from "@/services/desktop/runtime";
import { changeDesktopDataRoot, type DataRootMode } from "@/services/desktop/data-root";
import type { StoredBlob } from "@/services/storage/driver";
import { getMaintenanceLease, getMaintenanceState, subscribeMaintenance, withStorageMaintenance } from "@/services/storage/maintenance";
import { currentMediaReferences, type MediaReference } from "@/services/storage/references";
import { formatDesktopBytes, StorageBackupControls } from "./storage-backup-controls";

type Usage = { databaseBytes: number; mediaBytes: number; previewBytes: number; pluginBytes: number; pendingDeletionBytes: number; files: number; missingFiles: MediaReference[] };
type CleanupPreview = { revision: number; files: StoredBlob[]; bytes: number; pendingFiles: number };

export function ConfigDesktopStorage({ active }: { active: boolean }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const { token } = theme.useToken();
    const maintenance = useSyncExternalStore(subscribeMaintenance, getMaintenanceState, getMaintenanceState);
    const [usage, setUsage] = useState<Usage | null>(null);
    const [preview, setPreview] = useState<CleanupPreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [cleaning, setCleaning] = useState(false);
    const [changing, setChanging] = useState(false);
    const [error, setError] = useState("");

    const reportError = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)), []);
    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try { setUsage(await desktopInvoke<Usage>("desktop_storage_usage")); }
        catch (reason) { reportError(reason); }
        finally { setLoading(false); }
    }, [reportError]);

    useEffect(() => { if (active) void refresh(); }, [active, refresh]);

    const scan = async () => {
        setScanning(true);
        setError("");
        setPreview(null);
        try {
            const result = await withStorageMaintenance(t("desktop.storage.scan"), async () => desktopInvoke<CleanupPreview>("desktop_cleanup_preview", {
                references: await currentMediaReferences(), lease: getMaintenanceLease(),
            }));
            setPreview(result);
        } catch (reason) { reportError(reason); }
        finally { setScanning(false); }
    };

    const clean = () => {
        if (!preview) return;
        const approved = preview;
        modal.confirm({
            title: t("desktop.storage.confirmTitle"),
            content: t("desktop.storage.confirmContent", { count: approved.files.length + approved.pendingFiles, bytes: formatDesktopBytes(approved.bytes) }),
            okText: t("desktop.storage.confirm"), cancelText: t("common.cancel"), okButtonProps: { danger: true },
            async onOk() {
                setCleaning(true);
                setError("");
                try {
                    const removed = await withStorageMaintenance(t("desktop.storage.clear"), async () => desktopInvoke<{ files: number; bytes: number }>("desktop_cleanup_commit", {
                        references: await currentMediaReferences(approved.files), expectedRevision: approved.revision, lease: getMaintenanceLease(),
                    }));
                    setPreview(null);
                    message.success(t("desktop.storage.deleted", { count: removed.files, bytes: formatDesktopBytes(removed.bytes) }));
                    await refresh();
                } catch (reason) { reportError(reason); throw reason; }
                finally { setCleaning(false); }
            },
        });
    };

    const reveal = async (reference?: MediaReference) => {
        try {
            if (reference) await desktopInvoke("desktop_reveal_blob", { namespace: reference.namespace, key: reference.key });
            else await desktopInvoke("desktop_open_data_root");
        } catch (reason) { reportError(reason); }
    };

    const changeDirectory = (mode: DataRootMode) => {
        const hint = t(`desktop.storage.${mode}DirectoryHint`);
        const confirmation = modal.confirm({
            title: t(mode === "copy" ? "desktop.storage.copyDirectory" : "desktop.storage.openExistingDirectory"),
            content: hint,
            okText: t("desktop.storage.chooseAndRestart"),
            cancelText: t("common.cancel"),
            async onOk() {
                setChanging(true);
                setError("");
                confirmation.update({ cancelButtonProps: { disabled: true }, keyboard: false });
                try {
                    await changeDesktopDataRoot(mode, t("desktop.storage.changingDirectory"));
                } catch (reason) {
                    reportError(reason);
                    confirmation.update({ content: <div className="space-y-3">
                        <p>{hint}</p>
                        <Alert type="error" showIcon title={t("desktop.error")} description={reason instanceof Error ? reason.message : String(reason)} />
                    </div> });
                    throw reason;
                } finally {
                    setChanging(false);
                    confirmation.update({ cancelButtonProps: { disabled: false }, keyboard: true });
                }
            },
        });
    };

    const disabled = maintenance.busy || maintenance.activities > 0 || scanning || cleaning || changing;
    const removable = preview ? preview.files.length + preview.pendingFiles : 0;
    const metrics = usage ? [
        ["database", usage.databaseBytes], ["media", usage.mediaBytes], ["previews", usage.previewBytes],
        ["plugin", usage.pluginBytes], ["pending", usage.pendingDeletionBytes],
    ] as const : [];

    return (
        <div className="space-y-3">
            <section className="rounded-lg border p-4" style={{ borderColor: token.colorBorderSecondary }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold"><Database className="size-4" />{t("desktop.storage.title")}</div>
                        <p className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>{t("desktop.storage.description")}</p>
                    </div>
                    <Button type="text" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>{t("desktop.refresh")}</Button>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                        <div className="text-xs" style={{ color: token.colorTextSecondary }}>{t("desktop.storage.directory")}</div>
                        <div className="mt-1 break-all font-mono text-xs">{getDesktopRuntime()?.dataRoot}</div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                        <Button type="text" icon={<FolderOpen className="size-4" />} onClick={() => void reveal()}>{t("desktop.storage.openDirectory")}</Button>
                        <Dropdown
                            disabled={disabled}
                            trigger={["click"]}
                            menu={{
                                items: [
                                    { key: "copy", label: t("desktop.storage.copyDirectory") },
                                    { key: "open", label: t("desktop.storage.openExistingDirectory") },
                                ],
                                onClick: ({ key }) => changeDirectory(key === "copy" ? "copy" : "open"),
                            }}
                        >
                            <Button type="text" icon={<FolderInput className="size-4" />} loading={changing} disabled={disabled}>
                                {t("desktop.storage.changeDirectory")}
                            </Button>
                        </Dropdown>
                    </div>
                </div>
                <p className="mt-2 text-xs" style={{ color: token.colorTextSecondary }}>{t("desktop.storage.directoryHint")}</p>
                {changing ? <p className="mt-2 text-xs" aria-live="polite">{t("desktop.storage.changingDirectory")}</p> : null}
                {!usage && loading ? <div className="flex justify-center py-8"><Spin /></div> : null}
                {usage ? (
                    <>
                        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                            {metrics.map(([label, bytes]) => <div key={label}><div className="text-xs" style={{ color: token.colorTextSecondary }}>{t(`desktop.storage.${label}`)}</div><div className="mt-1 text-lg font-semibold tabular-nums">{formatDesktopBytes(bytes)}</div></div>)}
                        </div>
                        <p className="mt-3 text-xs" style={{ color: token.colorTextSecondary }}>{t("desktop.storage.indexedFiles", { count: usage.files })}</p>
                    </>
                ) : null}
                {usage?.missingFiles.length ? (
                    <Alert className="mt-3" type="error" showIcon title={t("desktop.storage.missingTitle", { count: usage.missingFiles.length })} description={<>
                        <p>{t("desktop.storage.missingHint")}</p>
                        <ul className="mt-2 max-h-40 overflow-auto font-mono text-xs">{usage.missingFiles.map((file) => <li key={`${file.namespace}/${file.key}`} className="break-all">{file.namespace}/{file.key}</li>)}</ul>
                    </>} />
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button type="text" icon={<ScanLine className="size-4" />} loading={scanning} disabled={disabled} onClick={() => void scan()}>{t("desktop.storage.scan")}</Button>
                    {preview && removable > 0 ? <Button type="text" danger icon={<Trash2 className="size-4" />} loading={cleaning} disabled={disabled} onClick={clean}>{t("desktop.storage.clear")}</Button> : null}
                </div>
                <p className="mt-2 text-xs" style={{ color: token.colorTextSecondary }}>{t("desktop.storage.scanHint")}</p>
                {preview ? (
                    <div className="mt-3">
                        <Alert type="info" showIcon title={removable ? t("desktop.storage.scanTitle", { count: removable, bytes: formatDesktopBytes(preview.bytes) }) : t("desktop.storage.noUnused")} description={<>
                            <span>{t("desktop.storage.scanFirst")}</span>
                            {preview.pendingFiles ? <p>{t("desktop.storage.scanPending", { count: preview.pendingFiles })}</p> : null}
                        </>} />
                        {preview.files.length ? <Collapse className="mt-2" ghost items={[{
                            key: "files", label: t("common.details"), children: <Table<StoredBlob>
                                size="small" dataSource={preview.files} rowKey={(file) => `${file.namespace}/${file.key}`}
                                columns={[
                                    { title: t("desktop.storage.name"), key: "key", render: (_value, file) => <span className="break-all font-mono text-xs">{file.namespace}/{file.key}</span> },
                                    { title: t("desktop.storage.size"), dataIndex: "size", render: (bytes: number) => <span className="whitespace-nowrap tabular-nums">{formatDesktopBytes(bytes)}</span> },
                                    { key: "reveal", render: (_value, file) => <Button type="text" size="small" icon={<FolderOpen className="size-4" />} onClick={() => void reveal(file)}>{t("desktop.storage.reveal")}</Button> },
                                ]}
                            />,
                        }]} /> : null}
                    </div>
                ) : null}
                {error ? <Alert className="mt-3" type="error" showIcon title={t("desktop.error")} description={error} /> : null}
            </section>
            <StorageBackupControls />
        </div>
    );
}
