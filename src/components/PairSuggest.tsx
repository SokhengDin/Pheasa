import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, Cpu, Download, HardDrive, Languages, Loader } from "lucide-react";

import { api, errorText, formatBytes } from "../lib/api";
import { languageName } from "../lib/types";
import type { DownloadProgress, ModelMeta, Recommendation, RuntimeStatus, Settings } from "../lib/types";

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
                <button className="btn" disabled>
                    <Loader size={16} className="spin" />
                    <span>{pct > 0 ? `${pct.toFixed(0)}%` : "Starting"}</span>
                </button>
            );
        }

        if (rec.installed) {
            return (
                <button className="btn primary" onClick={() => use(rec.id)}>
                    <CircleCheck size={16} />
                    <span>Use</span>
                </button>
            );
        }

        if (rec.backend !== "native" && !runtime?.ready) {
            return (
                <button className="btn" onClick={() => onOpen("storage")} title="This model runs on the Python runtime">
                    <Cpu size={16} />
                    <span>{rec.backend === "mlx" ? "Set up MLX" : "Set up Python"}</span>
                </button>
            );
        }

        if (rec.backend === "mlx" && !runtime?.mlx) {
            return (
                <button className="btn" onClick={() => onOpen("storage")} title="Add the MLX packages to the runtime">
                    <Cpu size={16} />
                    <span>Add MLX</span>
                </button>
            );
        }

        return (
            <button className="btn primary" onClick={() => download(rec)}>
                <Download size={16} />
                <span>Download</span>
            </button>
        );
    };

    const pair  = `${languageName(src)} to ${languageName(tgt)}`;
    const title = chosen ? `${chosen.id} does not cover ${pair}` : `No translation model for ${pair}`;

    return (
        <div className="callout suggest">
            <Languages size={20} />

            <div className="grow">
                <strong>{title}</strong>
                <div className="muted">Pick one of these. It downloads once, then it is used automatically.</div>

                <ul className="suggest-list">
                    {recs.slice(0, 4).map((rec) => (
                        <li key={rec.id}>
                            <div className="grow">
                                <div className="name">{rec.id}</div>
                                <div className="meta">
                                    <span className="stat"><HardDrive size={12} />about {formatBytes(rec.size_bytes)}</span>
                                    <span>{rec.note}</span>
                                </div>
                            </div>

                            {action(rec)}
                        </li>
                    ))}
                </ul>

                {error ? <div className="muted error-text">{error}</div> : null}
            </div>

            <button className="btn" onClick={() => onOpen("models")}>More models</button>
        </div>
    );
}
