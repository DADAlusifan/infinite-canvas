import { Alert, App, Button, Form, Input, Radio, theme } from "antd";
import { Network, RefreshCw } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { getDesktopRuntime, updateDesktopNetwork, type DesktopNetwork } from "@/services/desktop/runtime";
import { getMaintenanceState, subscribeMaintenance } from "@/services/storage/maintenance";

export function ConfigDesktopNetwork() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { token } = theme.useToken();
    const [network, setNetwork] = useState<DesktopNetwork>(() => getDesktopRuntime()?.network || { mode: "system", url: "" });
    const [error, setError] = useState(() => getDesktopRuntime()?.networkError || "");
    const [saving, setSaving] = useState(false);
    const maintenance = useSyncExternalStore(subscribeMaintenance, getMaintenanceState, getMaintenanceState);

    const save = async (refresh = false) => {
        setSaving(true);
        setError("");
        try {
            const next = await updateDesktopNetwork({ ...network, url: network.url.trim() });
            setNetwork(next);
            message.success(t(refresh ? "desktop.network.refreshDone" : "desktop.network.saved"));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally { setSaving(false); }
    };

    return (
        <Form layout="vertical" requiredMark={false} onFinish={() => void save()}>
            <section className="rounded-lg border p-4" style={{ borderColor: token.colorBorderSecondary }}>
                <div className="flex items-center gap-2 text-sm font-semibold"><Network className="size-4" />{t("desktop.network.title")}</div>
                <p className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>{t("desktop.network.description")}</p>
                <Form.Item className="mt-4" label={t("desktop.network.mode")}>
                    <Radio.Group
                        value={network.mode}
                        disabled={saving || maintenance.busy}
                        onChange={(event) => setNetwork((current) => ({ ...current, mode: event.target.value }))}
                        options={["system", "direct", "manual"].map((mode) => ({ value: mode, label: t(`desktop.network.${mode}`) }))}
                    />
                </Form.Item>
                <p className="mb-3 text-xs" style={{ color: token.colorTextSecondary }}>{t(`desktop.network.${network.mode}Hint`)}</p>
                {network.mode === "manual" ? (
                    <Form.Item label={t("desktop.network.address")}>
                        <Input
                            value={network.url}
                            placeholder="http://127.0.0.1:7890"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={saving || maintenance.busy}
                            onChange={(event) => setNetwork((current) => ({ ...current, url: event.target.value }))}
                        />
                    </Form.Item>
                ) : null}
                {network.mode === "system" ? <Alert type="info" showIcon title={t("desktop.network.pacHint")} className="mb-3" /> : null}
                {error ? <Alert type="error" showIcon title={t("desktop.network.failure")} description={error} className="mb-3" /> : null}
                <div className="flex flex-wrap gap-2">
                    <Button htmlType="submit" loading={saving} disabled={maintenance.busy}>{t("desktop.network.save")}</Button>
                    {network.mode === "system" ? (
                        <Button type="text" icon={<RefreshCw className="size-4" />} disabled={saving || maintenance.busy} onClick={() => void save(true)}>{t("desktop.network.refresh")}</Button>
                    ) : null}
                </div>
            </section>
        </Form>
    );
}
