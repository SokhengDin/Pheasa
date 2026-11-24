import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api, errorText } from "../lib/api";
import type { Backend, DownloadProgress, Task } from "../lib/types";

/** Download progress for any model, shared by the setup wizard. */
export function useDownloads(onDone: () => void) {
    const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
    const [error, setError]       = useState<string | null>(null);

    useEffect(() => {
        const unlisten = listen<DownloadProgress>("model-download", (event) => {
            setProgress((prev) => ({ ...prev, [event.payload.id]: event.payload }));

            if (event.payload.done) onDone();
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [onDone]);

    const start = useCallback(async (id: string, task: Task, backend: Backend) => {
        setError(null);
        setProgress((prev) => ({ ...prev, [id]: { id, downloaded: 0, total: 0, done: false } }));

        try {
            await api.downloadModel(id, task, backend);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setProgress((prev) => {
                const { [id]: _removed, ...rest } = prev;
                return rest;
            });
        }
    }, []);

    return { progress, error, start };
}
