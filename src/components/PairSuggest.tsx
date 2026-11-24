import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, Cpu, Download, HardDrive, Languages, Loader } from "lucide-react";

import { api, errorText, formatBytes } from "../lib/api";
import { languageName } from "../lib/types";
import type { DownloadProgress, ModelMeta, Recommendation, RuntimeStatus, Settings } from "../lib/types";
import { ACCENT_FILL, Button, cx, SURFACE } from "./ui";

interface Props {
    settings : Settings;
    onChange : (settings: Settings) => void;
    onOpen   : (view: "models" | "settings" | "storage") => void;
    onNeed   : (needed: boolean) => void;
}

/** The language pair the first translation model has to cover. */
function neededPair(settings: Settings): [string, string] {
    const { source_lang: src, target_lang: tgt } = settings;

    return settings.mt_model_2 && src !== "en" && tgt !== "en" ? [src, "en"] : [src, tgt];
}

/**
 * Suggests translation models for the chosen language pair, with a download button,
 * when no model is chosen or the chosen one covers another pair.
 */
export function PairSuggest({ settings, onChange, onOpen, onNeed }: Props) {
    const [src, tgt] = neededPair(settings);

    const [recs, setRecs]           = useState<Recommendation[]>([]);
    const [installed, setInstalled] = useState<ModelMeta[]>([]);
    const [runtime, setRuntime]     = useState<RuntimeStatus | null>(null);
    const [progress, setProgress]   = useState<Record<string, DownloadProgress>>({});
    const [error, setError]         = useState<string | null>(null);

    const refresh = useCallback(() => {
        api.listInstalled("translation").then(setInstalled).catch(() => undefined);
    }, []);

    useEffect(() => {
        refresh();
        api.runtimeStatus().then(setRuntime).catch(() => undefined);
    }, [refresh]);

    useEffect(() => {
        let current = true;

        api.recommended("translation", src, tgt)
            .then((list) => { if (current) setRecs(list); })
            .catch(() => { if (current) setRecs([]); });

        return () => { current = false; };
    }, [src, tgt]);

    useEffect(() => {
        const unlisten = listen<DownloadProgress>("model-download", (event) => {
            const p = event.payload;

            setProgress((prev) => ({ ...prev, [p.id]: p }));

            if (p.done) {
                refresh();
                setRecs((prev) => prev.map((r) => (r.id === p.id ? { ...r, installed: true } : r)));
            }
        });

        return () => { unlisten.then((fn) => fn()); };
    }, [refresh]);

    const chosen = installed.find((m) => m.id === settings.mt_model);
    const fits   = !!chosen && (!chosen.src_lang || !chosen.tgt_lang || (chosen.src_lang === src && chosen.tgt_lang === tgt));

    const needed = settings.mt_backend === "local" && src !== tgt && src !== "auto" && !fits;

    useEffect(() => {
        onNeed(needed);
    }, [needed, onNeed]);

    if (!needed) return null;

    const use = (id: string) => onChange({ ...settings, mt_model: id, mt_backend: "local" });

    const download = async (rec: Recommendation) => {
        setError(null);
        setProgress((prev) => ({ ...prev, [rec.id]: { id: rec.id, downloaded: 0, total: 0, done: false } }));

        try {
            await api.downloadModel(rec.id, rec.task, rec.backend);
            use(rec.id);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setProgress((prev) => {
                const { [rec.id]: _removed, ...rest } = prev;
                return rest;
            });
        }
    };

    const action = (rec: Recommendation) => {
        const p   = progress[rec.id];
        const pct = p && p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;

        if (p) {
            return (
                <Button disabled>
                    <Loader size={16} className="animate-spin" />
                    <span>{pct > 0 ? `${pct.toFixed(0)}%` : "Starting"}</span>
                </Button>
            );
        }

        if (rec.installed) {
            return (
                <Button variant="primary" onClick={() => use(rec.id)}>
                    <CircleCheck size={16} />
                    <span>Use</span>
                </Button>
            );
        }

        if (rec.backend !== "native" && !runtime?.ready) {
            return (
                <Button onClick={() => onOpen("storage")} title="This model runs on the Python runtime">
                    <Cpu size={16} />
                    <span>{rec.backend === "mlx" ? "Set up MLX" : "Set up Python"}</span>
                </Button>
            );
        }

        if (rec.backend === "mlx" && !runtime?.mlx) {
            return (
                <Button onClick={() => onOpen("storage")} title="Add the MLX packages to the runtime">
                    <Cpu size={16} />
                    <span>Add MLX</span>
                </Button>
            );
        }

        return (
            <Button variant="primary" onClick={() => download(rec)}>
                <Download size={16} />
                <span>Download</span>
            </Button>
        );
    };

    const pair  = `${languageName(src)} to ${languageName(tgt)}`;
    const title = chosen ? `${chosen.id} does not cover ${pair}` : `No translation model for ${pair}`;

    return (
        <div
            className={cx(
                "relative mx-gutter my-1.5 flex shrink-0 items-start gap-3.5 rounded-card px-4 py-3.5 animate-rise",
                SURFACE,
                "bg-[linear-gradient(135deg,color-mix(in_srgb,var(--accent)_14%,transparent),color-mix(in_srgb,var(--accent-2)_6%,transparent))]",
            )}
        >
            <span className={cx("flex shrink-0 items-center justify-center rounded-[11px] p-2", ACCENT_FILL)}>
                <Languages size={20} />
            </span>

            <div className="min-w-0 flex-1">
                <strong>{title}</strong>
                <div className="text-muted">Pick one of these. It downloads once, then it is used automatically.</div>

                <ul className="m-0 mt-2.5 flex list-none flex-col gap-2 p-0">
                    {recs.slice(0, 4).map((rec) => (
                        <li key={rec.id} className="flex items-center gap-3 rounded-[10px] bg-surface-hi px-3 py-2.5 shadow-soft inset-shadow-specular">
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-semibold">{rec.id}</div>
                                <div className="flex items-center gap-2.5 text-small text-muted">
                                    <span className="inline-flex items-center gap-1"><HardDrive size={12} />about {formatBytes(rec.size_bytes)}</span>
                                    <span>{rec.note}</span>
                                </div>
                            </div>

                            {action(rec)}
                        </li>
                    ))}
                </ul>

                {error ? <div className="mt-1.5 text-bad">{error}</div> : null}
            </div>

            <Button onClick={() => onOpen("models")}>More models</Button>
        </div>
    );
}
