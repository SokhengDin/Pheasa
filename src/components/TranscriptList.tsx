import { useEffect, useRef, useState } from "react";
import { ArrowDown, AudioLines, Check, Copy, MessageSquareText } from "lucide-react";

import { formatClock } from "../lib/api";
import type { TranscriptLine } from "../lib/types";
import { SpeakerTag } from "./SpeakerTag";
import { TypingDots } from "./TypingDots";
import { GLASS_STRONG, EmptyState, IconButton, buttonClass, cx } from "./ui";

interface Props {
    lines    : TranscriptLine[];
    names    : Record<string, string>;
    onRename : (speaker: string, name: string) => void;
    onRemember?: (speaker: string, name: string) => void;
    /** The translator is listening: an empty list then means "waiting for speech". */
    listening?: boolean;
    /** A floating dock covers the bottom edge (Live page): leave room for it. */
    docked?  : boolean;
}

export function TranscriptList({ lines, names, onRename, onRemember, listening = false, docked = false }: Props) {
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
            <EmptyState icon={AudioLines} title="Listening" breathe className={docked ? "pb-[120px]" : undefined}>
                Subtitles appear here as soon as someone speaks. Check the level meters at the top if nothing shows up.
            </EmptyState>
        );
    }

    if (lines.length === 0) {
        return (
            <EmptyState icon={MessageSquareText} title="Nothing to translate yet" className={docked ? "pb-[120px]" : undefined}>
                Press Start, then speak or join a call. Subtitles appear here as people talk.
            </EmptyState>
        );
    }

    return (
        <div className="relative flex min-h-0 flex-1">
            <div
                ref={box}
                onScroll={onScroll}
                role="log"
                aria-live="polite"
                className={cx("flex flex-1 flex-col gap-1 overflow-y-auto px-gutter pt-2", docked ? "pb-28" : "pb-10")}
            >
                {lines.map((line) => (
                    // Big, legible translation; the newest line is a glass card.
                    <div
                        key={line.id}
                        className={cx(
                            "group relative rounded-card py-3 pr-11 pl-4 transition-[background,box-shadow] duration-250 ease-spring animate-rise",
                            "hover:bg-fill last:hover:bg-surface @max-[760px]:py-2.5 @max-[760px]:pr-10 @max-[760px]:pl-3",
                            "last:bg-surface last:shadow-soft last:inset-shadow-specular last:backdrop-blur-xl last:backdrop-saturate-180",
                            !line.is_final && "opacity-60",
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <SpeakerTag
                                speaker={line.speaker}
                                source={line.source}
                                names={names}
                                onRename={onRename}
                                known={line.known}
                                canRemember={listening}
                                onRemember={onRemember}
                            />
                            <time className="text-tiny text-faint tabular-nums" title="Time since the translator started">{formatClock(line.started_ms)}</time>
                        </div>

                        <div className="mt-1 font-display text-[21px] leading-[1.3] font-semibold tracking-[-.015em] @max-[760px]:text-[18px]">
                            {line.translation ?? <TypingDots />}
                        </div>
                        <div className="mt-1 text-body text-muted">{line.text}</div>

                        {line.is_final ? (
                            <IconButton
                                className="absolute top-2.5 right-2.5 opacity-0 transition-opacity group-hover:opacity-100"
                                title="Copy translation"
                                onClick={() => copy(line)}
                            >
                                {copied === line.id ? <Check size={14} /> : <Copy size={14} />}
                            </IconButton>
                        ) : null}
                    </div>
                ))}
            </div>

            {!pinned ? (
                <button
                    type="button"
                    className={cx(
                        buttonClass("default", "md"),
                        GLASS_STRONG,
                        "rim absolute left-1/2 -translate-x-1/2 animate-rise enabled:active:scale-95 enabled:hover:bg-glass-strong enabled:hover:brightness-104",
                        docked ? "bottom-24" : "bottom-[18px]",
                    )}
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
