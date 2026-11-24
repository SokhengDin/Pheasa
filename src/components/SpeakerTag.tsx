import { useState } from "react";
import { Check, Fingerprint, Mic, Monitor, Pencil } from "lucide-react";

import { speakerColor } from "../lib/prefs";
import { IconButton, TextInput, cx } from "./ui";

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
                className="inline-flex items-center gap-1"
                onSubmit={(e) => {
                    e.preventDefault();
                    commit();
                }}
            >
                <TextInput autoFocus className="w-[140px]" value={draft} placeholder={speaker} onChange={(e) => setDraft(e.target.value)} />
                <IconButton type="submit" title="Rename here only"><Check size={14} /></IconButton>
                {offer ? (
                    <IconButton title="Save this name and remember the voice" onMouseDown={(e) => e.preventDefault()} onClick={remember}>
                        <Fingerprint size={14} />
                    </IconButton>
                ) : null}
            </form>
        );
    }

    return (
        // A capsule tinted with the speaker's own colour (currentColor).
        <button
            type="button"
            className={cx(
                "group inline-flex h-[22px] items-center gap-[5px] rounded-full pr-[9px] pl-[7px] text-small font-semibold transition-[background] duration-250 ease-spring",
                unknown
                    ? "border border-dashed border-current bg-transparent"
                    : "border-0 bg-current/13 shadow-[inset_0_0_0_.5px_color-mix(in_srgb,currentColor_18%,transparent)] hover:bg-current/20",
            )}
            style={{ color: speakerColor(speaker) }}
            title={unknown ? "Unknown voice. Click to name it" : "Rename speaker"}
            onClick={() => {
                setDraft(names[speaker] ?? "");
                setEditing(true);
            }}
        >
            <Icon size={14} />
            <span>{shown}</span>
            <Pencil size={11} className="w-0 opacity-0 transition-[opacity,width] duration-250 ease-spring group-hover:w-[11px] group-hover:opacity-70" />
        </button>
    );
}
