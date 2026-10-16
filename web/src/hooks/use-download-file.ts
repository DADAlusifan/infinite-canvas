import { useCallback } from "react";
import { App } from "antd";
import { saveFile } from "@/services/desktop/files";

export function useDownloadFile() {
    const { message } = App.useApp();
    return useCallback((data: Blob | string, filename: string) => {
        void saveFile(data, filename).catch((error) => message.error(error instanceof Error ? error.message : "文件保存失败"));
    }, [message]);
}
