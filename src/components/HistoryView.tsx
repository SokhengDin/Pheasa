import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Download, History, Search, Trash2 } from "lucide-react";

import { api, errorText } from "../lib/api";
import { buildExport } from "../lib/exporter";
import type { Session, SessionInfo } from "../lib/types";
import { languageName } from "../lib/types";
import { TranscriptList } from "./TranscriptList";

interface Props {
    names    : Record<string, string>;
    onRename : (speaker: string, name: string) => void;
}

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
            <div className="view">
                <header className="toolbar">
                    <button className="btn" onClick={() => setOpen(null)}>
                        <ArrowLeft size={16} /><span>History</span>
                    </button>

                    <strong>{open.title}</strong>
                    <span className="muted">{languageName(open.source_lang)} to {languageName(open.target_lang)}</span>

                    <div className="spacer" />

                    <button className="btn" onClick={exportOpen}><Download size={16} /><span>Export</span></button>
                    <button className="btn" onClick={() => remove(open.id)}><Trash2 size={16} /><span>Delete</span></button>
                </header>

                <TranscriptList lines={open.entries} names={names} onRename={onRename} />
            </div>
        );
    }

    return (
        <div className="view">
            <header className="toolbar">
                <h1 className="page-title">History</h1>

                <div className="spacer" />

                <form className="search" onSubmit={(e) => { e.preventDefault(); refresh(); }}>
                    <Search size={16} />
                    <input value={query} placeholder="Search saved conversations" onChange={(e) => setQuery(e.target.value)} />
                </form>
            </header>

            {error ? <div className="status error"><span>{error}</span></div> : null}

            {items.length === 0 ? (
                <div className="empty">
                    <History size={28} strokeWidth={1.5} />
                    <strong>{query ? "No matches" : "No saved conversations"}</strong>
                    <span>Conversations are saved when you stop the translator, or with the save button.</span>
                </div>
            ) : (
                <section className="results">
                    {items.map((s) => (
                        <div key={s.id} className="row clickable" onClick={() => show(s.id)}>
                            <div className="grow">
                                <div className="name">{s.title}</div>
                                <div className="meta">
                                    <span>{when(s.id)}</span>
                                    <span>{languageName(s.source_lang)} to {languageName(s.target_lang)}</span>
                                    <span>{s.count} lines</span>
                                    {s.matches > 0 ? <span className="badge good">{s.matches} matches</span> : null}
                                </div>
                                <div className="muted clip">{s.preview}</div>
                            </div>

                            {confirm === s.id ? (
                                <button className="btn danger" onClick={(e) => { e.stopPropagation(); remove(s.id); }}>
                                    <Trash2 size={16} /><span>Confirm</span>
                                </button>
                            ) : (
                                <button
                                    className="icon-btn"
                                    title="Delete"
                                    onClick={(e) => { e.stopPropagation(); setConfirm(s.id); }}
                                >
                                    <Trash2 size={16} />
                                </button>
                            )}
                        </div>
                    ))}
                </section>
            )}
        </div>
    );
}
