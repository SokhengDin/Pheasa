import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { CornerDownLeft, Search } from "lucide-react";

import { ACCENT_FILL, cx, GLASS_STRONG, Kbd } from "./ui";

export interface Command {
    id       : string;
    label    : string;
    icon     : LucideIcon;
    group    : string;
    /** Extra words that should match, e.g. "start" for "Start translating". */
    keywords?: string;
    /** Shortcut shown on the right, e.g. "⌘↩". */
    hint?    : string;
    /** Only listed once the person has typed something (long lists such as languages). */
    searchOnly?: boolean;
    disabled?: boolean;
    run      : () => void;
}

interface Props {
    open     : boolean;
    commands : Command[];
    onClose  : () => void;
}

/** Every word of the query must appear somewhere in the label or keywords. */
function matches(command: Command, query: string): boolean {
    const haystack = `${command.label} ${command.keywords ?? ""} ${command.group}`.toLowerCase();

    return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** Spotlight-style command palette, opened with Cmd/Ctrl+K. */
export function CommandPalette({ open, commands, onClose }: Props) {
    const [query, setQuery]   = useState("");
    const [active, setActive] = useState(0);
    const input               = useRef<HTMLInputElement>(null);
    const list                = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;

        setQuery("");
        setActive(0);
        window.setTimeout(() => input.current?.focus(), 0);
    }, [open]);

    const shown = useMemo(() => {
        const q = query.trim();

        return commands.filter((c) => !c.disabled && (q ? matches(c, q) : !c.searchOnly)).slice(0, 60);
    }, [commands, query]);

    useEffect(() => setActive(0), [query]);

    // Keep the highlighted row in view while moving with the arrow keys.
    useEffect(() => {
        list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active]);

    if (!open) return null;

    const run = (command: Command | undefined) => {
        if (!command) return;

        onClose();
        command.run();
    };

    const onKey = (event: React.KeyboardEvent) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((i) => Math.min(shown.length - 1, i + 1));
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => Math.max(0, i - 1));
        } else if (event.key === "Enter") {
            event.preventDefault();
            run(shown[active]);
        } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
        }
    };

    let lastGroup = "";

    return (
        <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/10 pt-[14vh] animate-fade [animation-duration:.2s]" onMouseDown={onClose}>
            <div
                className={cx("relative flex max-h-[62vh] w-[min(640px,90vw)] flex-col overflow-hidden rounded-pane animate-pop rim", GLASS_STRONG)}
                role="dialog"
                aria-label="Commands"
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={onKey}
            >
                <div className="flex h-[60px] shrink-0 items-center gap-3 border-b-[.5px] border-separator px-[22px] text-muted">
                    <Search size={18} className="shrink-0" />
                    <input
                        ref={input}
                        value={query}
                        placeholder="Search for a command or a language"
                        onChange={(e) => setQuery(e.target.value)}
                        spellCheck={false}
                        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-display text-[20px] tracking-[-.01em] text-fg outline-none focus-visible:outline-none"
                    />
                    <Kbd>esc</Kbd>
                </div>

                <div className="overflow-y-auto px-2.5 pt-1.5 pb-2.5" ref={list}>
                    {shown.length === 0 ? <div className="p-7 text-center text-muted">No matching commands</div> : null}

                    {shown.map((command, index) => {
                        const header = command.group !== lastGroup ? command.group : null;
                        const Icon   = command.icon;
                        const on     = index === active;

                        lastGroup = command.group;

                        return (
                            <div key={command.id}>
                                {header ? <div className="px-2.5 pt-2.5 pb-1 text-tiny font-semibold text-faint">{header}</div> : null}
                                <button
                                    data-index={index}
                                    className={cx(
                                        "flex h-10 w-full items-center gap-2.5 rounded-[10px] border-0 pr-2.5 pl-[7px] text-left",
                                        on ? ACCENT_FILL : "bg-transparent text-fg",
                                    )}
                                    onMouseMove={() => setActive(index)}
                                    onClick={() => run(command)}
                                >
                                    <span
                                        className={cx(
                                            "inline-flex size-7 shrink-0 items-center justify-center rounded-[9px]",
                                            on ? "bg-white/22 text-white" : "bg-fill text-accent",
                                        )}
                                    >
                                        <Icon size={15} />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                                    {command.hint ? <Kbd className={on ? "bg-white/20! text-white!" : undefined}>{command.hint}</Kbd> : null}
                                    {on ? <CornerDownLeft size={14} className="shrink-0 opacity-80" /> : null}
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
