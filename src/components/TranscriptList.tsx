import { useEffect, useRef, useState } from "react";
import { ArrowDown, AudioLines, Check, Copy, MessageSquareText } from "lucide-react";

import { formatClock } from "../lib/api";
import type { TranscriptLine } from "../lib/types";
import { SpeakerTag } from "./SpeakerTag";
import { TypingDots } from "./TypingDots";

interface Props {
    lines    : TranscriptLine[];
    names    : Record<string, string>;
    onRename : (speaker: string, name: string) => void;
    onRemember?: (speaker: string, name: string) => void;
    /** The translator is listening: an empty list then means "waiting for speech". */
    listening?: boolean;
}

export function TranscriptList({ lines, names, onRename, onRemember, listening = false }: Props) {
    const box                   = useRef<HTMLDivElement>(null);
    const [pinned, setPinned]   = useState(true);
    const [copied, setCopied]   = useState<number | null>(null);

    // Follow new lines, unless the person scrolled up to read.
    useEffect(() => {
        const el = box.current;

        if (el && pinned) el.scrollTop = el.scrollHeight;
    }, [lines, pinned]);

    const onScroll = () => {
        const el = box.current;

        if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
    };

    const copy = async (line: TranscriptLine) => {
        try {
            await navigator.clipboard.writeText(line.translation ?? line.text);
            setCopied(line.id);
            window.setTimeout(() => setCopied((id) => (id === line.id ? null : id)), 1200);
        } catch {
            // Clipboard can be blocked; nothing else to do.
        }
    };

    if (lines.length === 0 && listening) {
        return (
            <div className="empty">
                <AudioLines size={32} strokeWidth={1.5} className="breathe" />
                <strong>Listening</strong>
                <span>Subtitles appear here as soon as someone speaks. Check the level meters above if nothing shows up.</span>
            </div>
        );
    }

    if (lines.length === 0) {
        return (
            <div className="empty">
                <MessageSquareText size={32} strokeWidth={1.5} />
                <strong>Nothing to translate yet</strong>
                <span>Press Start, then speak or join a call. Subtitles appear here as people talk.</span>
            </div>
        );
    }

    return (
        <div className="transcript-wrap">
            <div className="transcript" ref={box} onScroll={onScroll} role="log" aria-live="polite">
                {lines.map((line) => (
                    <div key={line.id} className={`line ${line.is_final ? "" : "partial"}`}>
                        <div className="line-head">
                            <SpeakerTag
                                speaker={line.speaker}
                                source={line.source}
                                names={names}
                                onRename={onRename}
                                known={line.known}
                                canRemember={listening}
                                onRemember={onRemember}
                            />
                            <time className="stamp" title="Time since the translator started">{formatClock(line.started_ms)}</time>
                        </div>

                        <div className="translation">{line.translation ?? <TypingDots />}</div>
                        <div className="original">{line.text}</div>

                        {line.is_final ? (
                            <button className="icon-btn copy" title="Copy translation" onClick={() => copy(line)}>
                                {copied === line.id ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                        ) : null}
                    </div>
                ))}
            </div>

            {!pinned ? (
                <button
                    className="btn jump"
                    onClick={() => {
                        setPinned(true);
                        box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
                    }}
                >
                    <ArrowDown size={14} />
                    <span>Jump to latest</span>
                </button>
            ) : null}
        </div>
    );
}
