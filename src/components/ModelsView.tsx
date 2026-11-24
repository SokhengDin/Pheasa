import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
    CircleCheck,
    Cpu,
    Download,
    HardDrive,
    Heart,
    Search,
    Sparkles,
    Tag as TagIcon,
    Trash2,
    TriangleAlert,
    X,
} from "lucide-react";

import { api, errorText, formatBytes, formatCount } from "../lib/api";
import type {
    Backend,
    DownloadProgress,
    ModelCard,
    ModelMeta,
    Recommendation,
    RuntimeStatus,
    Settings,
    Task,
} from "../lib/types";

const TABS: { id: Task; label: string; hint: string }[] = [
    { id: "stt",         label: "Speech to text", hint: "Whisper and other speech models"  },
    { id: "translation", label: "Translation",    hint: "opus-mt, NLLB, M2M100"            },
    { id: "tts",         label: "Text to speech", hint: "Voices that read the translation" },
    { id: "speaker",     label: "Speakers",       hint: "Speaker verification models"      },
];

/** Hub tags that narrow the search. "mlx" is the Apple GPU build of a model. */
const TAG_PRESETS: { id: string; label: string; hint: string }[] = [
    { id: "",    label: "All models",      hint: "Every model of this kind"                  },
    { id: "mlx", label: "Apple GPU (MLX)", hint: "Converted to run on Apple silicon"         },
    { id: "gpu", label: "GPU",             hint: "Models carrying the gpu tag on Hugging Face" },
];

/** Hub tags are lowercase words; anything else would never match. */
function cleanTag(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

interface Props {
    settings : Settings;
    onChange : (settings: Settings) => void;
    onOpen   : (view: "storage") => void;
}

/** What a row needs to show and download, from a search card or a recommendation. */
interface Item {
    id         : string;
    task       : Task;
    backend    : Backend;
    note       : string;
    size_bytes : number;
    installed  : boolean;
    compatible : boolean;
}

function BackendBadge({ backend }: { backend: Backend }) {
    if (backend === "native") return <span className="badge good">Built-in</span>;
    if (backend === "mlx")    return <span className="badge accent">Apple GPU</span>;

    return <span className="badge">Python</span>;
}

export function ModelsView({ settings, onChange, onOpen }: Props) {
    const [task, setTask]           = useState<Task>("stt");
    const [query, setQuery]         = useState("");
    const [tag, setTag]             = useState("");
    const [customTag, setCustomTag] = useState("");
    const [cards, setCards]         = useState<ModelCard[]>([]);
    const [recs, setRecs]           = useState<Recommendation[]>([]);
    const [installed, setInstalled] = useState<ModelMeta[]>([]);
    const [runtime, setRuntime]     = useState<RuntimeStatus | null>(null);
    const [loading, setLoading]     = useState(false);
    const [error, setError]         = useState<string | null>(null);
    const [progress, setProgress]   = useState<Record<string, DownloadProgress>>({});
    const request                   = useRef(0);

    const refreshInstalled = useCallback(
        () => api.listInstalled(null).then(setInstalled).catch(() => undefined),
        [],
    );

    const search = useCallback(async (override?: string) => {
        const ticket = ++request.current;

        setLoading(true);
        setError(null);

        try {
            const result = await api.searchModels(task, override ?? query, tag);

            if (ticket === request.current) setCards(result);
        } catch (err) {
            if (ticket === request.current) setError(errorText(err));
        } finally {
            if (ticket === request.current) setLoading(false);
        }
    }, [task, query, tag]);

    useEffect(() => {
        search();
        api.recommended(task, settings.source_lang, settings.target_lang).then(setRecs).catch(() => setRecs([]));
        // Re-run only when the tab, the tag or the language pair changes; typing waits for Enter.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task, tag, settings.source_lang, settings.target_lang]);

    useEffect(() => {
        refreshInstalled();
        api.runtimeStatus().then(setRuntime).catch(() => undefined);

        const unlisten = listen<DownloadProgress>("model-download", (event) => {
            const p = event.payload;

            setProgress((prev) => ({ ...prev, [p.id]: p }));

            if (p.done) {
                refreshInstalled();
                setCards((prev) => prev.map((c) => (c.id === p.id ? { ...c, installed: true } : c)));
                setRecs((prev) => prev.map((c) => (c.id === p.id ? { ...c, installed: true } : c)));
            }
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [refreshInstalled]);

    const download = async (item: Item) => {
        setError(null);
        setProgress((prev) => ({ ...prev, [item.id]: { id: item.id, downloaded: 0, total: 0, done: false } }));

        try {
            await api.downloadModel(item.id, item.task, item.backend);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setProgress((prev) => {
                const { [item.id]: _removed, ...rest } = prev;
                return rest;
            });
        }
    };

    const remove = async (id: string, kind: Task) => {
        try {
            onChange(await api.deleteModel(id, kind));
        } catch (err) {
            setError(errorText(err));
            return;
        }

        refreshInstalled();
        setCards((prev) => prev.map((c) => (c.id === id ? { ...c, installed: false } : c)));
        setRecs((prev) => prev.map((c) => (c.id === id ? { ...c, installed: false } : c)));
    };

    const use = (item: Item, second = false) => {
        if (item.task === "stt")     onChange({ ...settings, stt_model: item.id });
        if (item.task === "tts")     onChange({ ...settings, tts_model: item.id });
        if (item.task === "speaker") onChange({ ...settings, speaker_model: item.id, separate_remote_speakers: true });

        if (item.task === "translation") {
            onChange(second
                ? { ...settings, mt_model_2: item.id, mt_backend: "local" }
                : { ...settings, mt_model: item.id, mt_backend: "local" });
        }
    };

    const active = (item: Item) =>
        [settings.stt_model, settings.mt_model, settings.tts_model, settings.speaker_model].includes(item.id);

    const activeSecond = (item: Item) => settings.mt_model_2 === item.id;

    const here          = installed.filter((m) => m.task === task);
    const needsRuntime  = (item: Item) => item.backend !== "native" && !runtime?.ready;
    const needsMlx      = (item: Item) => item.backend === "mlx" && !!runtime?.ready && !runtime.mlx;
    const anyPythonHere = [...cards, ...recs].some((c) => c.backend !== "native");

    const pickTag = (id: string) => {
        setTag(id);
        setCustomTag("");
    };

    const customActive = tag !== "" && !TAG_PRESETS.some((t) => t.id === tag);

    const asItem = (c: ModelCard | Recommendation): Item => ({
        id         : c.id,
        task       : c.task,
        backend    : c.backend,
        note       : c.note,
        size_bytes : c.size_bytes,
        installed  : c.installed,
        compatible : "compatible" in c ? c.compatible : true,
    });

    const renderAction = (item: Item) => {
        const p   = progress[item.id];
        const pct = p && p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;

        if (p) {
            return (
                <button className="btn" onClick={() => api.cancelDownload(item.id)} title="Cancel and remove the partial files">
                    <X size={16} />
                    <span>{pct > 0 ? `${pct.toFixed(0)}%` : "Starting"}</span>
                </button>
            );
        }

        if (item.installed) {
            return (
                <div className="actions">
                    <button className={`btn ${active(item) ? "primary" : ""}`} onClick={() => use(item)}>
                        <CircleCheck size={16} />
                        <span>{active(item) ? "In use" : "Use"}</span>
                    </button>

                    {item.task === "translation" ? (
                        <button
                            className={`btn ${activeSecond(item) ? "primary" : ""}`}
                            onClick={() => use(item, true)}
                            title="Translate through English: this model handles the English to target step"
                        >
                            <span>{activeSecond(item) ? "Step 2" : "As step 2"}</span>
                        </button>
                    ) : null}
                </div>
            );
        }

        if (!item.compatible) {
            return <button className="btn" disabled><span>Unsupported</span></button>;
        }

        if (needsRuntime(item)) {
            return (
                <button className="btn" onClick={() => onOpen("storage")} title="This model runs on the Python runtime">
                    <Cpu size={16} />
                    <span>{item.backend === "mlx" ? "Set up MLX" : "Set up Python"}</span>
                </button>
            );
        }

        if (needsMlx(item)) {
            return (
                <button className="btn" onClick={() => onOpen("storage")} title="Add the MLX packages to the runtime">
                    <Cpu size={16} />
                    <span>Add MLX</span>
                </button>
            );
        }

        return (
            <button className="btn" onClick={() => download(item)}>
                <Download size={16} />
                <span>Download{item.size_bytes > 0 ? ` (${formatBytes(item.size_bytes)})` : ""}</span>
            </button>
        );
    };

    const renderProgress = (id: string) => {
        const p = progress[id];

        if (!p) return null;

        const pct = p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;

        return <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>;
    };

    return (
        <div className="view">
            <header className="toolbar">
                <div className="tabs">
                    {TABS.map((tab) => (
                        <button
                            key={tab.id}
                            className={`tab ${task === tab.id ? "active" : ""}`}
                            onClick={() => setTask(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="spacer" />

                <form
                    className="search"
                    onSubmit={(e) => {
                        e.preventDefault();
                        search();
                    }}
                >
                    <Search size={16} />
                    <input
                        value={query}
                        placeholder={`Search Hugging Face: ${TABS.find((t) => t.id === task)?.hint}`}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </form>
            </header>

            <div className="chips" role="group" aria-label="Filter by Hugging Face tag">
                {TAG_PRESETS.map((preset) => (
                    <button
                        key={preset.id || "all"}
                        className={`chip ${tag === preset.id ? "active" : ""}`}
                        title={preset.hint}
                        aria-pressed={tag === preset.id}
                        onClick={() => pickTag(preset.id)}
                    >
                        {preset.id ? <TagIcon size={12} /> : null}
                        <span>{preset.label}</span>
                    </button>
                ))}

                <form
                    className={`chip-input ${customActive ? "active" : ""}`}
                    onSubmit={(e) => {
                        e.preventDefault();
                        setTag(cleanTag(customTag));
                    }}
                >
                    <TagIcon size={12} />
                    <input
                        value={customTag}
                        placeholder="Other tag, then Enter"
                        aria-label="Custom Hugging Face tag"
                        onChange={(e) => setCustomTag(e.target.value)}
                    />
                    {customActive ? (
                        <button type="button" className="chip-clear" title="Clear the tag" onClick={() => pickTag("")}>
                            <X size={12} />
                        </button>
                    ) : null}
                </form>
            </div>

            {tag === "mlx" && !runtime?.mlx_supported ? (
                <div className="hint">
                    MLX models run only on a Mac with Apple silicon. You can browse them here, but they stay marked unsupported on this computer.
                </div>
            ) : null}

            {anyPythonHere && !runtime?.ready ? (
                <div className="callout">
                    <Cpu size={20} />
                    <div className="grow">
                        <strong>Most models need the Python runtime</strong>
                        <div className="muted">
                            The built-in engine runs Whisper and Marian. Everything else runs through Python,
                            installed in the app's own folder and removable in one click.
                        </div>
                    </div>
                    <button className="btn primary" onClick={() => onOpen("storage")}>Set up</button>
                </div>
            ) : null}

            {task === "translation" && settings.source_lang !== "en" && settings.target_lang !== "en"
                && settings.source_lang !== "auto" ? (
                <div className="hint">
                    No model for {settings.source_lang} to {settings.target_lang}? Use one model for the language to English,
                    and mark another as "step 2" for English to the target. NLLB and M2M100 cover many pairs alone.
                </div>
            ) : null}

            {error ? (
                <div className="status error">
                    <TriangleAlert size={14} />
                    <span>{error}</span>
                </div>
            ) : null}

            {here.length > 0 ? (
                <section className="installed">
                    <h3>Installed</h3>

                    {here.map((m) => (
                        <div key={m.id} className="row">
                            <CircleCheck size={16} className="ok" />
                            <div className="grow">
                                <div className="name">{m.id}</div>
                                <div className="meta">
                                    <BackendBadge backend={m.backend} />
                                    <span className="stat"><HardDrive size={12} />{formatBytes(m.size_bytes)}</span>
                                    {m.src_lang && m.tgt_lang ? <span>{m.src_lang} to {m.tgt_lang}</span> : null}
                                </div>
                            </div>

                            {renderAction(asItem({ ...m, installed: true, compatible: true } as unknown as ModelCard))}

                            <button className="icon-btn" onClick={() => remove(m.id, m.task)} title="Delete every file of this model">
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))}
                </section>
            ) : null}

            {recs.length > 0 ? (
                <section className="results">
                    <h3><Sparkles size={14} /> Recommended</h3>

                    {recs.map((rec) => {
                        const item = asItem(rec);

                        return (
                            <div key={rec.id} className="row">
                                <div className="grow">
                                    <div className="name">{rec.id}</div>
                                    <div className="meta">
                                        <BackendBadge backend={rec.backend} />
                                        <span className="stat"><HardDrive size={12} />about {formatBytes(rec.size_bytes)}</span>
                                        <span>{rec.note}</span>
                                    </div>
                                    {renderProgress(rec.id)}
                                </div>

                                {renderAction(item)}
                            </div>
                        );
                    })}
                </section>
            ) : null}

            <section className="results">
                <h3>
                    {query.trim() ? "Results" : "Most downloaded"}
                    {tag ? <span className="muted"> tagged {tag}</span> : null}
                </h3>

                {loading ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" />) : null}

                {!loading && cards.length === 0 && !error ? (
                    <div className="empty">
                        <Search size={28} strokeWidth={1.5} />
                        <strong>No models found</strong>
                        <span>
                            {tag
                                ? `Nothing carries the "${tag}" tag for this search. Try another tag, or clear it.`
                                : 'Try a shorter search, such as "whisper" or "opus-mt".'}
                        </span>
                    </div>
                ) : null}

                {!loading ? cards.map((card) => (
                    <div key={card.id} className={`row ${card.compatible ? "" : "dim"}`}>
                        <div className="grow">
                            <div className="name">{card.id}</div>

                            <div className="meta">
                                {card.compatible ? <BackendBadge backend={card.backend} /> : null}
                                <span className="stat"><Download size={12} />{formatCount(card.downloads)}</span>
                                <span className="stat"><Heart size={12} />{formatCount(card.likes)}</span>
                                {card.size_bytes > 0 ? <span className="stat"><HardDrive size={12} />{formatBytes(card.size_bytes)}</span> : null}
                                <span className={`badge ${card.compatible ? "good" : "bad"}`}>{card.note}</span>
                            </div>

                            {renderProgress(card.id)}
                        </div>

                        {renderAction(asItem(card))}
                    </div>
                )) : null}
            </section>
        </div>
    );
}
