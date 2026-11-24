import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Download, History, Search, Trash2 } from "lucide-react";

import { api, errorText } from "../lib/api";
import { buildExport } from "../lib/exporter";
import type { Session, SessionInfo } from "../lib/types";
import { languageName } from "../lib/types";
import { TranscriptList } from "./TranscriptList";
import { Badge, Button, EmptyState, GLASS, IconButton, SURFACE, cx } from "./ui";

interface Props {
    names    : Record<string, string>;
    onRename : (speaker: string, name: string) => void;
}

const PAGE    = "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto animate-fade";
const TOOLBAR = "sticky top-0 z-[5] flex shrink-0 flex-wrap items-center gap-2 px-gutter pt-3 pb-2.5 mac:pt-3.5 scroll-edge";

/** Toolbar buttons drop their labels when the window is narrow. */
const TOOL_BTN = "max-[900px]:px-[9px] max-[900px]:[&>span]:hidden";

function when(id: number): string {
    return new Date(id).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function HistoryView({ names, onRename }: Props) {
    const [query, setQuery]     = useState("");
    const [items, setItems]     = useState<SessionInfo[]>([]);
    const [open, setOpen]       = useState<Session | null>(null);
    const [error, setError]     = useState<string | null>(null);
    const [confirm, setConfirm] = useState<number | null>(null);

    const refresh = useCallback(
        (q = query) => api.listSessions(q).then(setItems).catch((err) => setError(errorText(err))),
        [query],
    );

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const show = async (id: number) => {
        try {
            setOpen(await api.loadSession(id));
        } catch (err) {
            setError(errorText(err));
        }
    };

    const remove = async (id: number) => {
        setConfirm(null);
        await api.deleteSession(id).catch((err) => setError(errorText(err)));

        if (open?.id === id) setOpen(null);

        refresh();
    };

    const exportOpen = async () => {
        if (!open) return;

        const text = buildExport(open.entries, {
            format  : "txt",
            content : "both",
            names,
            source  : open.source_lang,
            target  : open.target_lang,
        });

        await api.saveTextFile(`${open.title}.txt`, "txt", text).catch((err) => setError(errorText(err)));
    };

    if (open) {
        return (
            <div className={PAGE}>
                <header className={TOOLBAR} data-tauri-drag-region>
                    <Button variant="glass" size="md" className={TOOL_BTN} onClick={() => setOpen(null)}>
                        <ArrowLeft size={16} /><span>History</span>
                    </Button>

                    <strong>{open.title}</strong>
                    <span className="text-muted">{languageName(open.source_lang)} to {languageName(open.target_lang)}</span>

                    <div className="flex-1" />

                    <Button variant="glass" size="md" className={TOOL_BTN} onClick={exportOpen}><Download size={16} /><span>Export</span></Button>
                    <Button variant="glass" size="md" className={TOOL_BTN} onClick={() => remove(open.id)}><Trash2 size={16} /><span>Delete</span></Button>
                </header>

                <TranscriptList lines={open.entries} names={names} onRename={onRename} />
            </div>
        );
    }

    return (
        <div className={PAGE}>
            <header className={TOOLBAR} data-tauri-drag-region>
                <h1 className="m-0 ml-1 font-display text-[22px] font-bold tracking-[-.025em]">History</h1>

                <div className="flex-1" />

                <form
                    className={cx(
                        "flex h-8 min-w-[280px] items-center gap-1.5 rounded-full px-3.5 text-muted @max-[760px]:min-w-0 @max-[760px]:flex-1",
                        "transition-[box-shadow,background] duration-250 ease-spring",
                        GLASS,
                        "focus-within:bg-surface-hi focus-within:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--accent)_40%,transparent)]",
                    )}
                    onSubmit={(e) => { e.preventDefault(); refresh(); }}
                >
                    <Search size={16} />
                    <input
                        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-fg outline-none"
                        value={query}
                        placeholder="Search saved conversations"
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </form>
            </header>

            {error ? (
                <div className="mx-gutter flex shrink-0 items-center gap-2 px-1 pt-1.5 pb-2 text-small font-medium text-bad">
                    <span>{error}</span>
                </div>
            ) : null}

            {items.length === 0 ? (
                <EmptyState icon={History} title={query ? "No matches" : "No saved conversations"}>
                    Conversations are saved when you stop the translator, or with the save button.
                </EmptyState>
            ) : (
                <section className="shrink-0 px-gutter pt-3">
                    {items.map((s) => (
                        <div
                            key={s.id}
                            className={cx(
                                "relative mb-2 flex cursor-pointer items-center gap-3 rounded-row px-4 py-3 animate-rise",
                                SURFACE,
                                "transition-[box-shadow,transform] duration-250 ease-bounce hover:-translate-y-px hover:shadow-lift active:scale-99",
                            )}
                            onClick={() => show(s.id)}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">{s.title}</div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-small text-muted">
                                    <span>{when(s.id)}</span>
                                    <span>{languageName(s.source_lang)} to {languageName(s.target_lang)}</span>
                                    <span>{s.count} lines</span>
                                    {s.matches > 0 ? <Badge tone="good">{s.matches} matches</Badge> : null}
                                </div>
                                <div className="max-w-[60ch] truncate text-muted">{s.preview}</div>
                            </div>

                            {confirm === s.id ? (
                                <Button variant="danger" onClick={(e) => { e.stopPropagation(); remove(s.id); }}>
                                    <Trash2 size={16} /><span>Confirm</span>
                                </Button>
                            ) : (
                                <IconButton
                                    title="Delete"
                                    onClick={(e) => { e.stopPropagation(); setConfirm(s.id); }}
                                >
                                    <Trash2 size={16} />
                                </IconButton>
                            )}
                        </div>
                    ))}
                </section>
            )}
        </div>
    );
}
