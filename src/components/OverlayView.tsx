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
        <div className="overlay" style={style} onMouseDown={startDrag}>
            <div className="overlay-bar">
                <GripHorizontal size={16} />

                <div className="overlay-tools">
                    <button className="icon-btn" title="Dock to the top of this screen" onClick={() => dock("top")}>
                        <ArrowUpToLine size={14} />
                    </button>

                    <button className="icon-btn" title="Dock to the bottom of this screen" onClick={() => dock("bottom")}>
                        <ArrowDownToLine size={14} />
                    </button>

                    <button
                        className="icon-btn"
                        title="Smaller text"
                        onClick={() => setPrefs({ ...prefs, fontSize: Math.max(12, prefs.fontSize - 2) })}
                    >
                        <Minus size={14} />
                    </button>

                    <ALargeSmall size={14} />

                    <button
                        className="icon-btn"
                        title="Larger text"
                        onClick={() => setPrefs({ ...prefs, fontSize: Math.min(64, prefs.fontSize + 2) })}
                    >
                        <Plus size={14} />
                    </button>

                    <button
                        className={`icon-btn ${prefs.showOriginal ? "on" : ""}`}
                        title="Show the original text"
                        onClick={() => setPrefs({ ...prefs, showOriginal: !prefs.showOriginal })}
                    >
                        <Languages size={14} />
                    </button>

                    <button
                        className="icon-btn"
                        title="Lock: let the mouse pass through. Unlock from the main window"
                        onClick={() => setPrefs({ ...prefs, locked: true })}
                    >
                        <Lock size={14} />
                    </button>

                    <button className="icon-btn" title="Hide" onClick={() => win.hide()}>
                        <X size={14} />
                    </button>
                </div>
            </div>

            {recent.length === 0 ? (
                <div className="overlay-line muted">Waiting for speech</div>
            ) : (
                recent.map((line) => {
                    const shown = names[line.speaker] || line.speaker;

                    return (
                        <div key={line.id} className={`overlay-line ${line.is_final ? "" : "partial"}`}>
                            {prefs.showSpeaker ? (
                                <span className="overlay-speaker" style={{ color: speakerColor(line.speaker) }}>
                                    {shown}
                                </span>
                            ) : null}

                            <div className="overlay-translation">{line.translation ?? <TypingDots />}</div>

                            {prefs.showOriginal ? <div className="overlay-original">{line.text}</div> : null}
                        </div>
                    );
                })
            )}

            <button
                className="overlay-grip"
                title="Resize"
                onMouseDown={(e) => {
                    e.stopPropagation();
                    win.startResizeDragging("SouthEast").catch(() => undefined);
                }}
            />
        </div>
    );
}
