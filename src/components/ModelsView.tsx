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
import {
    Badge,
    Button,
    Callout,
    cx,
    EmptyState,
    GLASS,
    IconButton,
    ProgressBar,
    SectionLabel,
    Segmented,
    Skeleton,
    SURFACE,
    TINT,
} from "./ui";

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

const ROW  = cx("relative mb-2 flex items-center gap-3 rounded-row px-4 py-3 animate-rise transition-[box-shadow,transform,background] duration-250 ease-spring", SURFACE);
const META = "mt-0.5 flex flex-wrap items-center gap-2.5 text-small text-muted";
const STAT = "inline-flex items-center gap-1";
const HINT = "m-0 shrink-0 px-gutter pt-2 pb-3 text-small text-muted";
const CHIP = "inline-flex h-6 items-center gap-[5px] rounded-full border-0 px-2.5 text-small transition-[background,color,box-shadow] duration-150";

function BackendBadge({ backend }: { backend: Backend }) {
    if (backend === "native") return <Badge tone="good">Built-in</Badge>;
    if (backend === "mlx")    return <Badge tone="accent">Apple GPU</Badge>;

    return <Badge>Python</Badge>;
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
                <Button onClick={() => api.cancelDownload(item.id)} title="Cancel and remove the partial files">
                    <X size={16} />
                    <span>{pct > 0 ? `${pct.toFixed(0)}%` : "Starting"}</span>
                </Button>
            );
        }

        if (item.installed) {
            return (
                <div className="flex shrink-0 gap-1.5">
                    <Button variant={active(item) ? "primary" : "default"} onClick={() => use(item)}>
                        <CircleCheck size={16} />
                        <span>{active(item) ? "In use" : "Use"}</span>
                    </Button>

                    {item.task === "translation" ? (
                        <Button
                            variant={activeSecond(item) ? "primary" : "default"}
                            onClick={() => use(item, true)}
                            title="Translate through English: this model handles the English to target step"
                        >
                            <span>{activeSecond(item) ? "Step 2" : "As step 2"}</span>
                        </Button>
                    ) : null}
                </div>
            );
        }

        if (!item.compatible) {
            return <Button disabled><span>Unsupported</span></Button>;
        }

        if (needsRuntime(item)) {
            return (
                <Button onClick={() => onOpen("storage")} title="This model runs on the Python runtime">
                    <Cpu size={16} />
                    <span>{item.backend === "mlx" ? "Set up MLX" : "Set up Python"}</span>
                </Button>
            );
        }

        if (needsMlx(item)) {
            return (
                <Button onClick={() => onOpen("storage")} title="Add the MLX packages to the runtime">
                    <Cpu size={16} />
                    <span>Add MLX</span>
                </Button>
            );
        }

        return (
            <Button onClick={() => download(item)}>
                <Download size={16} />
                <span>Download{item.size_bytes > 0 ? ` (${formatBytes(item.size_bytes)})` : ""}</span>
            </Button>
        );
    };

    const renderProgress = (id: string) => {
        const p = progress[id];

        if (!p) return null;

        const pct = p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;

        return <ProgressBar value={pct / 100} />;
    };

    return (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto animate-fade">
            <header className="sticky top-0 z-[5] flex shrink-0 flex-wrap items-center gap-2 px-gutter pt-3 pb-2.5 mac:pt-3.5 scroll-edge" data-tauri-drag-region>
                <Segmented
                    glass
                    label="Model kind"
                    options={TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
                    value={task}
                    onChange={setTask}
                />

                <div className="flex-1" />

                <form
                    className={cx(
                        "flex h-8 min-w-[280px] items-center gap-1.5 rounded-full px-3.5 text-muted",
                        "transition-[box-shadow,background] duration-250 ease-spring",
                        "focus-within:bg-surface-hi focus-within:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--accent)_40%,transparent)]",
                        "@max-[760px]:min-w-0 @max-[760px]:flex-1",
                        GLASS,
                    )}
                    onSubmit={(e) => {
                        e.preventDefault();
                        search();
                    }}
                >
                    <Search size={16} className="shrink-0" />
                    <input
                        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 outline-none focus-visible:outline-none"
                        value={query}
                        placeholder={`Search Hugging Face: ${TABS.find((t) => t.id === task)?.hint}`}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </form>
            </header>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-gutter pt-1.5" role="group" aria-label="Filter by Hugging Face tag">
                {TAG_PRESETS.map((preset) => (
                    <button
                        key={preset.id || "all"}
                        className={cx(CHIP, tag === preset.id ? `${TINT} font-medium` : "bg-fill text-fg hover:bg-fill-hover")}
                        title={preset.hint}
                        aria-pressed={tag === preset.id}
                        onClick={() => pickTag(preset.id)}
                    >
                        {preset.id ? <TagIcon size={12} /> : null}
                        <span>{preset.label}</span>
                    </button>
                ))}

                <form
                    className={cx(CHIP, "focus-within:outline-2 focus-within:outline-accent", customActive ? `${TINT} font-medium` : "bg-fill text-muted")}
                    onSubmit={(e) => {
                        e.preventDefault();
                        setTag(cleanTag(customTag));
                    }}
                >
                    <TagIcon size={12} className="shrink-0" />
                    <input
                        className="h-full w-[130px] border-0 bg-transparent p-0 text-small text-inherit outline-none focus-visible:outline-none"
                        value={customTag}
                        placeholder="Other tag, then Enter"
                        aria-label="Custom Hugging Face tag"
                        onChange={(e) => setCustomTag(e.target.value)}
                    />
                    {customActive ? (
                        <button
                            type="button"
                            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-inherit hover:bg-accent/22"
                            title="Clear the tag"
                            onClick={() => pickTag("")}
                        >
                            <X size={12} />
                        </button>
                    ) : null}
                </form>
            </div>

            {tag === "mlx" && !runtime?.mlx_supported ? (
                <div className={HINT}>
                    MLX models run only on a Mac with Apple silicon. You can browse them here, but they stay marked unsupported on this computer.
                </div>
            ) : null}

            {anyPythonHere && !runtime?.ready ? (
                <Callout
                    className="mx-gutter my-1.5"
                    icon={Cpu}
                    title="Most models need the Python runtime"
                    action={<Button variant="primary" onClick={() => onOpen("storage")}>Set up</Button>}
                >
                    The built-in engine runs Whisper and Marian. Everything else runs through Python,
                    installed in the app's own folder and removable in one click.
                </Callout>
            ) : null}

            {task === "translation" && settings.source_lang !== "en" && settings.target_lang !== "en"
                && settings.source_lang !== "auto" ? (
                <div className={HINT}>
                    No model for {settings.source_lang} to {settings.target_lang}? Use one model for the language to English,
                    and mark another as "step 2" for English to the target. NLLB and M2M100 cover many pairs alone.
                </div>
            ) : null}

            {error ? (
                <div className="shrink-0 px-gutter pt-1.5 pb-2">
                    <div className="flex items-center gap-2 px-1 text-small font-medium text-bad">
                        <TriangleAlert size={14} className="shrink-0" />
                        <span>{error}</span>
                    </div>
                </div>
            ) : null}

            {here.length > 0 ? (
                <section className="shrink-0 px-gutter pt-3">
                    <SectionLabel>Installed</SectionLabel>

                    {here.map((m) => (
                        <div key={m.id} className={ROW}>
                            <CircleCheck size={16} className="shrink-0 text-good" />
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">{m.id}</div>
                                <div className={META}>
                                    <BackendBadge backend={m.backend} />
                                    <span className={STAT}><HardDrive size={12} />{formatBytes(m.size_bytes)}</span>
                                    {m.src_lang && m.tgt_lang ? <span>{m.src_lang} to {m.tgt_lang}</span> : null}
                                </div>
                            </div>

                            {renderAction(asItem({ ...m, installed: true, compatible: true } as unknown as ModelCard))}

                            <IconButton onClick={() => remove(m.id, m.task)} title="Delete every file of this model">
                                <Trash2 size={16} />
                            </IconButton>
                        </div>
                    ))}
                </section>
            ) : null}

            {recs.length > 0 ? (
                <section className="shrink-0 px-gutter pt-3">
                    <SectionLabel className="flex items-center gap-1"><Sparkles size={14} /> Recommended</SectionLabel>

                    {recs.map((rec) => {
                        const item = asItem(rec);

                        return (
                            <div key={rec.id} className={ROW}>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-medium">{rec.id}</div>
                                    <div className={META}>
                                        <BackendBadge backend={rec.backend} />
                                        <span className={STAT}><HardDrive size={12} />about {formatBytes(rec.size_bytes)}</span>
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

            <section className="shrink-0 px-gutter pt-3">
                <SectionLabel>
                    {query.trim() ? "Results" : "Most downloaded"}
                    {tag ? <span className="text-muted"> tagged {tag}</span> : null}
                </SectionLabel>

                {loading ? [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} />) : null}

                {!loading && cards.length === 0 && !error ? (
                    <EmptyState icon={Search} title="No models found">
                        {tag
                            ? `Nothing carries the "${tag}" tag for this search. Try another tag, or clear it.`
                            : 'Try a shorter search, such as "whisper" or "opus-mt".'}
                    </EmptyState>
                ) : null}

                {!loading ? cards.map((card) => (
                    <div key={card.id} className={ROW}>
                        <div className="min-w-0 flex-1">
                            <div className={cx("truncate font-medium", !card.compatible && "text-muted")}>{card.id}</div>

                            <div className={META}>
                                {card.compatible ? <BackendBadge backend={card.backend} /> : null}
                                <span className={STAT}><Download size={12} />{formatCount(card.downloads)}</span>
                                <span className={STAT}><Heart size={12} />{formatCount(card.likes)}</span>
                                {card.size_bytes > 0 ? <span className={STAT}><HardDrive size={12} />{formatBytes(card.size_bytes)}</span> : null}
                                <Badge tone={card.compatible ? "good" : "bad"}>{card.note}</Badge>
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
