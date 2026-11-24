import { useState } from "react";
import { Check, Fingerprint, Mic, Monitor, Pencil } from "lucide-react";

import { speakerColor } from "../lib/prefs";

interface Props {
    speaker      : string;
    source       : "mic" | "system";
    names        : Record<string, string>;
    onRename     : (speaker: string, name: string) => void;
    /** False for a voice nobody has named yet. */
    known?       : boolean;
    /** The translator is running, so an unknown voice can be saved from this meeting. */
    canRemember? : boolean;
    onRemember?  : (speaker: string, name: string) => void;
}

/**
 * Speaker label that can be renamed: "Speaker A" becomes "Marie" everywhere, exports included.
 * An unknown voice also offers to remember the voice, so the person is named automatically next time.
 */
export function SpeakerTag({ speaker, source, names, onRename, known = true, canRemember = false, onRemember }: Props) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft]     = useState("");

    const shown   = names[speaker] || speaker;
    const Icon    = source === "mic" ? Mic : Monitor;
    const unknown = source === "system" && !known;
    const offer   = canRemember && unknown && Boolean(onRemember);

    const commit = () => {
        onRename(speaker, draft.trim());
        setEditing(false);
    };

    const remember = () => {
        const name = draft.trim();

        if (name && onRemember) onRemember(speaker, name);

        setEditing(false);
    };

    if (editing) {
        return (
            <form
                className="speaker-edit"
                onSubmit={(e) => {
                    e.preventDefault();
                    commit();
                }}
            >
                <input autoFocus value={draft} placeholder={speaker} onChange={(e) => setDraft(e.target.value)} />
                <button className="icon-btn" type="submit" title="Rename here only"><Check size={14} /></button>
                {offer ? (
                    <button className="icon-btn" type="button" title="Save this name and remember the voice" onMouseDown={(e) => e.preventDefault()} onClick={remember}>
                        <Fingerprint size={14} />
                    </button>
                ) : null}
            </form>
        );
    }

    return (
        <button
            className={`speaker-tag ${unknown ? "unknown" : ""}`}
            style={{ color: speakerColor(speaker) }}
            title={unknown ? "Unknown voice. Click to name it" : "Rename speaker"}
            onClick={() => {
                setDraft(names[speaker] ?? "");
                setEditing(true);
            }}
        >
            <Icon size={14} />
            <span>{shown}</span>
            <Pencil size={11} className="edit-hint" />
        </button>
    );
}
