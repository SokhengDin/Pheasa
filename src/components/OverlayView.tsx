import { useEffect, useMemo, useRef } from "react";
import {
    availableMonitors,
    currentMonitor,
    getCurrentWindow,
    PhysicalPosition,
    PhysicalSize,
} from "@tauri-apps/api/window";
import {
    ALargeSmall,
    ArrowDownToLine,
    ArrowUpToLine,
    GripHorizontal,
    Languages,
    Lock,
    Minus,
    Plus,
    X,
} from "lucide-react";

import { useEngine } from "../hooks/useEngine";
import { TypingDots } from "./TypingDots";
import { cx, IconButton } from "./ui";
import {
    FONT_STACKS,
    GEOMETRY_KEY,
    NAMES_KEY,
    OVERLAY_DEFAULTS,
    OVERLAY_KEY,
    speakerColor,
    usePersisted,
} from "../lib/prefs";

interface Geometry {
    x : number;
    y : number;
    w : number;
    h : number;
}

const MARGIN = 48;

export function OverlayView() {
    const { lines }       = useEngine({ speech: false });
    const [prefs, setPrefs] = usePersisted(OVERLAY_KEY, OVERLAY_DEFAULTS);
    const [names]         = usePersisted<Record<string, string>>(NAMES_KEY, {});
    const saveTimer       = useRef<number | undefined>(undefined);

    const win    = getCurrentWindow();
    const recent = useMemo(() => lines.slice(-prefs.lines), [lines, prefs.lines]);

    // Restore the last position and size, but only if it is still on a connected screen.
    useEffect(() => {
        (async () => {
            try {
                const raw = localStorage.getItem(GEOMETRY_KEY);

                if (raw) {
                    const g: Geometry = JSON.parse(raw);
                    const monitors    = await availableMonitors();

                    const visible = monitors.some((m) => {
                        const cx = g.x + g.w / 2;
                        const cy = g.y + g.h / 2;

                        return (
                            cx >= m.position.x && cx <= m.position.x + m.size.width &&
                            cy >= m.position.y && cy <= m.position.y + m.size.height
                        );
                    });

                    if (visible) {
                        await win.setSize(new PhysicalSize(g.w, g.h));
                        await win.setPosition(new PhysicalPosition(g.x, g.y));
                    } else {
                        await dock("bottom");
                    }
                } else {
                    await dock("bottom");
                }

                // Follow the person across desktops and spaces.
                await win.setVisibleOnAllWorkspaces(true);
            } catch {
                // Positioning is a convenience; the window still works where it is.
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Remember where the window was left, after the drag stops.
    useEffect(() => {
        const save = () => {
            window.clearTimeout(saveTimer.current);

            saveTimer.current = window.setTimeout(async () => {
                try {
                    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);

                    localStorage.setItem(
                        GEOMETRY_KEY,
                        JSON.stringify({ x: pos.x, y: pos.y, w: size.width, h: size.height }),
                    );
                } catch {
                    // Ignore: nothing to remember.
                }
            }, 400);
        };

        const unlisten = Promise.all([win.onMoved(save), win.onResized(save)]);

        return () => {
            unlisten.then((fns) => fns.forEach((fn) => fn()));
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Locked: the mouse passes straight through to whatever is underneath.
    useEffect(() => {
        win.setIgnoreCursorEvents(prefs.locked).catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prefs.locked]);

    async function dock(edge: "top" | "bottom") {
        const monitor = await currentMonitor();

        if (!monitor) return;

        const size  = await win.outerSize();
        const width = Math.min(size.width, monitor.size.width - MARGIN * 2);
        const x     = monitor.position.x + Math.round((monitor.size.width - width) / 2);
        const y     = edge === "top"
            ? monitor.position.y + MARGIN
            : monitor.position.y + monitor.size.height - size.height - MARGIN * 2;

        await win.setSize(new PhysicalSize(width, size.height));
        await win.setPosition(new PhysicalPosition(x, y));
    }

    const startDrag = (event: React.MouseEvent) => {
        if ((event.target as HTMLElement).closest("button, input")) return;

        win.startDragging().catch(() => undefined);
    };

    const style = {
        "--overlay-bg" : `rgba(10, 12, 16, ${prefs.opacity})`,
        "--overlay-fs" : `${prefs.fontSize}px`,
        "--overlay-blur": prefs.opacity < 0.05 ? "none" : "blur(24px) saturate(160%)",
        "--overlay-font"  : FONT_STACKS[prefs.fontFamily] ?? FONT_STACKS.system,
        "--overlay-color" : prefs.textColor,
        "--overlay-weight": prefs.bold ? 700 : 500,
        "--overlay-shadow": prefs.outline
            ? "-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 2px 6px rgba(0,0,0,.6)"
            : "none",
    } as React.CSSProperties;

    return (
        <div
            data-overlay
            className={cx(
                "group relative flex min-h-full cursor-grab flex-col gap-2 rounded-[14px] px-4 pt-1.5 pb-3.5 select-none rim",
                "text-white/95 bg-[var(--overlay-bg,rgba(14,16,20,.66))] inset-shadow-[0_1px_0_rgba(255,255,255,.12)]",
                "[backdrop-filter:var(--overlay-blur,blur(30px)_saturate(180%))] [-webkit-backdrop-filter:var(--overlay-blur,blur(30px)_saturate(180%))]",
                // Always dark: re-point the tokens the shared primitives use (IconButton, TypingDots, rim).
                "[--text:rgba(255,255,255,.95)] [--muted:rgba(255,255,255,.6)] [--accent:#64a8ff] [--fill-hover:rgba(255,255,255,.14)]",
                "[--rim-hi:rgba(255,255,255,.3)] [--rim-lo:rgba(255,255,255,.04)]",
            )}
            style={style}
            onMouseDown={startDrag}
        >
            <div className="flex items-center justify-between text-white/60">
                <GripHorizontal size={16} />

                <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    <IconButton title="Dock to the top of this screen" onClick={() => dock("top")}>
                        <ArrowUpToLine size={14} />
                    </IconButton>

                    <IconButton title="Dock to the bottom of this screen" onClick={() => dock("bottom")}>
                        <ArrowDownToLine size={14} />
                    </IconButton>

                    <IconButton
                        title="Smaller text"
                        onClick={() => setPrefs({ ...prefs, fontSize: Math.max(12, prefs.fontSize - 2) })}
                    >
                        <Minus size={14} />
                    </IconButton>

                    <ALargeSmall size={14} />

                    <IconButton
                        title="Larger text"
                        onClick={() => setPrefs({ ...prefs, fontSize: Math.min(64, prefs.fontSize + 2) })}
                    >
                        <Plus size={14} />
                    </IconButton>

                    <IconButton
                        active={prefs.showOriginal}
                        title="Show the original text"
                        onClick={() => setPrefs({ ...prefs, showOriginal: !prefs.showOriginal })}
                    >
                        <Languages size={14} />
                    </IconButton>

                    <IconButton
                        title="Lock: let the mouse pass through. Unlock from the main window"
                        onClick={() => setPrefs({ ...prefs, locked: true })}
                    >
                        <Lock size={14} />
                    </IconButton>

                    <IconButton title="Hide" onClick={() => win.hide()}>
                        <X size={14} />
                    </IconButton>
                </div>
            </div>

            {recent.length === 0 ? (
                <div className="text-white/60 animate-rise [animation-duration:.25s]">Waiting for speech</div>
            ) : (
                recent.map((line) => {
                    const shown = names[line.speaker] || line.speaker;

                    return (
                        <div key={line.id} className={cx("animate-rise [animation-duration:.25s]", !line.is_final && "opacity-60")}>
                            {prefs.showSpeaker ? (
                                <span className="text-small font-semibold" style={{ color: speakerColor(line.speaker) }}>
                                    {shown}
                                </span>
                            ) : null}

                            <div
                                className={cx(
                                    "text-[length:var(--overlay-fs,24px)] leading-[1.25] text-[color:var(--overlay-color,rgba(255,255,255,.95))]",
                                    "[font-weight:var(--overlay-weight,500)] [font-family:var(--overlay-font,inherit)] [text-shadow:var(--overlay-shadow,none)]",
                                )}
                            >
                                {line.translation ?? <TypingDots />}
                            </div>

                            {prefs.showOriginal ? (
                                <div className="text-[length:calc(var(--overlay-fs,24px)*.58)] text-white/60 [font-family:var(--overlay-font,inherit)] [text-shadow:var(--overlay-shadow,none)]">
                                    {line.text}
                                </div>
                            ) : null}
                        </div>
                    );
                })
            )}

            <button
                className={cx(
                    "absolute right-2 bottom-2 z-[1] size-3.5 cursor-nwse-resize border-0 p-0 opacity-0 group-hover:opacity-100",
                    "bg-[linear-gradient(135deg,transparent_50%,rgba(255,255,255,.6)_50%,rgba(255,255,255,.6)_60%,transparent_60%,transparent_75%,rgba(255,255,255,.6)_75%,rgba(255,255,255,.6)_85%,transparent_85%)]",
                )}
                title="Resize"
                onMouseDown={(e) => {
                    e.stopPropagation();
                    win.startResizeDragging("SouthEast").catch(() => undefined);
                }}
            />
        </div>
    );
}
