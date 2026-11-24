import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Fingerprint, Mic, Pencil, Trash2, X } from "lucide-react";

import { api, errorText } from "../lib/api";
import type { Settings, VoiceInfo } from "../lib/types";

const RECORD_SECONDS = 12;

interface Props {
    settings: Settings;
}

/** People the app recognises by voice, and a way to add yourself by recording a few seconds. */
export function VoicesPanel({ settings }: Props) {
    const [voices, setVoices]     = useState<VoiceInfo[]>([]);
    const [name, setName]         = useState("");
    const [left, setLeft]         = useState<number | null>(null);
    const [error, setError]       = useState<string | null>(null);
    const [editing, setEditing]   = useState<string | null>(null);
    const [draft, setDraft]       = useState("");
    const timer                   = useRef<number>(undefined);

    const refresh = useCallback(() => {
        api.listVoices().then(setVoices).catch((err) => setError(errorText(err)));
    }, []);

    useEffect(() => {
        refresh();

        return () => window.clearInterval(timer.current);
    }, [refresh]);

    const recording = left !== null;
    const ready     = Boolean(settings.speaker_model);

    const record = async () => {
        if (!name.trim() || recording) return;

        setError(null);
        setLeft(RECORD_SECONDS);

        timer.current = window.setInterval(() => setLeft((value) => (value && value > 1 ? value - 1 : value)), 1000);

        try {
            await api.enrollVoice(name.trim(), RECORD_SECONDS);
            setName("");
            refresh();
        } catch (err) {
            setError(errorText(err));
        } finally {
            window.clearInterval(timer.current);
            setLeft(null);
        }
    };

    const remove = async (id: string) => {
        try {
            await api.deleteVoice(id);
            refresh();
        } catch (err) {
            setError(errorText(err));
        }
    };

    const rename = async (id: string) => {
        const next = draft.trim();

        setEditing(null);

        if (!next) return;

        try {
            await api.renameVoice(id, next);
            refresh();
        } catch (err) {
            setError(errorText(err));
        }
    };

    return (
        <div className="voices">
            <div className="voices-head">
                <Fingerprint size={16} strokeWidth={1.75} />
                <strong>Known voices</strong>
            </div>

            {voices.length === 0 ? (
                <p className="hint inline">
                    Nobody saved yet. Record your own voice below, or click an unknown speaker in a live
                    meeting and choose the fingerprint button to save them.
                </p>
            ) : (
                <ul className="voice-list">
                    {voices.map((voice) => (
                        <li key={voice.id} className="voice-row">
                            {editing === voice.id ? (
                                <form
                                    className="speaker-edit"
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        void rename(voice.id);
                                    }}
                                >
                                    <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
                                    <button className="icon-btn" type="submit" title="Save the name"><Check size={14} /></button>
                                    <button className="icon-btn" type="button" title="Cancel" onClick={() => setEditing(null)}><X size={14} /></button>
                                </form>
                            ) : (
                                <>
                                    <span className="voice-name">{voice.name}</span>
                                    <small>{voice.samples} {voice.samples === 1 ? "sample" : "samples"}</small>
                                    <button
                                        className="icon-btn"
                                        title="Rename"
                                        onClick={() => {
                                            setDraft(voice.name);
                                            setEditing(voice.id);
                                        }}
                                    >
                                        <Pencil size={14} />
                                    </button>
                                    <button className="icon-btn" title="Forget this voice" onClick={() => void remove(voice.id)}>
                                        <Trash2 size={14} />
                                    </button>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <div className="voice-add">
                <input
                    value={name}
                    placeholder="Name, for example your own"
                    disabled={recording || !ready}
                    onChange={(e) => setName(e.target.value)}
                />

                <button className="btn" disabled={!ready || recording || !name.trim()} onClick={() => void record()}>
                    <Mic size={14} />
                    <span>{recording ? `Speak now, ${left}s` : `Record ${RECORD_SECONDS} seconds`}</span>
                </button>
            </div>

            {recording ? (
                <div className="bar" aria-hidden>
                    <div className="fill" style={{ width: `${((RECORD_SECONDS - (left ?? 0)) / RECORD_SECONDS) * 100}%` }} />
                </div>
            ) : null}

            {!ready ? (
                <p className="hint inline">Voices need a speaker model: download microsoft/wavlm-base-plus-sv in Models, under Speakers, and it is picked for you.</p>
            ) : (
                <p className="hint inline">
                    Stop the translator before recording. Talk normally, in a quiet room, until the timer ends.
                </p>
            )}

            {error ? <p className="voice-error">{error}</p> : null}
        </div>
    );
}
