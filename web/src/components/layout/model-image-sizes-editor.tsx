import { Button, Input, Modal, Typography } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { parseModelImageSizes } from "@/lib/model-image-sizes";

export function ModelImageSizesEditor({ modelName, value, onSave, onClose }: { modelName: string; value?: string[]; onSave: (sizes: string[] | undefined) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(value?.join("\n") || "");
    const [error, setError] = useState("");
    const changeDraft = (text: string) => {
        setDraft(text);
        setError("");
    };
    const save = () => {
        try {
            onSave(parseModelImageSizes(draft));
            onClose();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("modelImageSizes.invalidList"));
        }
    };

    return (
        <Modal open title={t("modelImageSizes.title", { model: modelName })} width={520} onCancel={onClose} onOk={save} okText={t("common.save")} cancelText={t("common.cancel")}>
            <div className="flex flex-col gap-3 py-2">
                <Typography.Text type="secondary">{t("modelImageSizes.description")}</Typography.Text>
                <div className="flex flex-wrap gap-2">
                    <Button size="small" type="text" onClick={() => changeDraft("")}>{t("modelImageSizes.reset")}</Button>
                </div>
                <Input.TextArea aria-label={t("modelImageSizes.label")} value={draft} onChange={(event) => changeDraft(event.target.value)} placeholder={t("modelImageSizes.placeholder")} autoSize={{ minRows: 8, maxRows: 14 }} status={error ? "error" : undefined} spellCheck={false} className="font-mono" />
                {error && <Typography.Text role="alert" type="danger">{error}</Typography.Text>}
            </div>
        </Modal>
    );
}
