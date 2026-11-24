import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Fingerprint, Mic, Pencil, Trash2, X } from "lucide-react";

import { api, errorText } from "../lib/api";
import type { Settings, VoiceInfo } from "../lib/types";
import { Button, IconButton, ProgressBar, TextInput } from "./ui";

const RECORD_SECONDS = 12;

/** Small muted note inside the voices block, without the card padding of Hint. */
const NOTE = "m-0 p-0 text-small text-muted";

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
        <div className="flex flex-col gap-2.5 border-t-[.5px] border-separator px-3.5 pt-3 pb-3.5">
            <div className="flex items-center gap-2">
                <Fingerprint size={16} strokeWidth={1.75} className="text-accent" />
                <strong>Known voices</strong>
            </div>

            {voices.length === 0 ? (
                <p className={NOTE}>
                    Nobody saved yet. Record your own voice below, or click an unknown speaker in a live
                    meeting and choose the fingerprint button to save them.
                </p>
            ) : (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                    {voices.map((voice) => (
                        <li key={voice.id} className="flex min-h-8 items-center gap-2 rounded-ctl px-2 hover:bg-fill">
                            {editing === voice.id ? (
                                <form
                                    className="inline-flex items-center gap-1"
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        void rename(voice.id);
                                    }}
                                >
                                    <TextInput autoFocus className="w-[140px]" value={draft} onChange={(e) => setDraft(e.target.value)} />
                                    <IconButton type="submit" title="Save the name"><Check size={14} /></IconButton>
                                    <IconButton type="button" title="Cancel" onClick={() => setEditing(null)}><X size={14} /></IconButton>
                                </form>
                            ) : (
                                <>
                                    <span className="flex-1 font-medium">{voice.name}</span>
                                    <small className="text-muted">{voice.samples} {voice.samples === 1 ? "sample" : "samples"}</small>
                                    <IconButton
                                        title="Rename"
                                        onClick={() => {
                                            setDraft(voice.name);
                                            setEditing(voice.id);
                                        }}
                                    >
                                        <Pencil size={14} />
                                    </IconButton>
                                    <IconButton title="Forget this voice" onClick={() => void remove(voice.id)}>
                                        <Trash2 size={14} />
                                    </IconButton>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <div className="flex items-center gap-2">
                <TextInput
                    className="min-w-0 flex-1"
                    value={name}
                    placeholder="Name, for example your own"
                    disabled={recording || !ready}
                    onChange={(e) => setName(e.target.value)}
                />

                <Button disabled={!ready || recording || !name.trim()} onClick={() => void record()}>
                    <Mic size={14} />
                    <span>{recording ? `Speak now, ${left}s` : `Record ${RECORD_SECONDS} seconds`}</span>
                </Button>
            </div>

            {recording ? (
                <div aria-hidden>
                    <ProgressBar value={(RECORD_SECONDS - (left ?? 0)) / RECORD_SECONDS} />
                </div>
            ) : null}

            {!ready ? (
                <p className={NOTE}>Voices need a speaker model: download microsoft/wavlm-base-plus-sv in Models, under Speakers, and it is picked for you.</p>
            ) : (
                <p className={NOTE}>
                    Stop the translator before recording. Talk normally, in a quiet room, until the timer ends.
                </p>
            )}

            {error ? <p className="m-0 text-small text-bad">{error}</p> : null}
        </div>
    );
}
