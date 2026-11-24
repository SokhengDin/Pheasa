import { Boxes, Captions, HardDrive, History, Loader, Search, Settings as SettingsIcon } from "lucide-react";

import { JOB_LABEL, useElapsed, useRuntimeJob } from "../lib/runtimeJob";
import { GLASS_STRONG, IndeterminateBar, Kbd, cx } from "./ui";

export type View = "live" | "history" | "models" | "storage" | "settings";

/** Each page gets its own tile colour, like System Settings. */
export const PAGES = [
    { id: "live",     label: "Live",     icon: Captions,     tile: "#2f6df0" },
    { id: "history",  label: "History",  icon: History,      tile: "#ff9500" },
    { id: "models",   label: "Models",   icon: Boxes,        tile: "#af52de" },
    { id: "storage",  label: "Storage",  icon: HardDrive,    tile: "#34c759" },
    { id: "settings", label: "Settings", icon: SettingsIcon, tile: "#8e8e93" },
] as const;

export const MOD = /Mac/i.test(navigator.userAgent) ? "⌘" : "Ctrl+";

/** Below 900 px the sidebar is an icon rail; these hide the text parts. */
const WIDE_ONLY = "max-[900px]:hidden";

interface Props {
    view      : View;
    device    : string;
    onChange  : (view: View) => void;
    onCommand : () => void;
}

/** Floating glass sidebar. On macOS the traffic lights sit inside its top-left corner. */
export function Sidebar({ view, device, onChange, onCommand }: Props) {
    const job     = useRuntimeJob();
    const elapsed = useElapsed(job.started);

    return (
        <nav
            className={cx(
                "relative z-[2] my-2 ml-2 flex w-[220px] shrink-0 flex-col gap-0.5 rounded-pane px-2.5 pt-1.5 pb-2.5 rim",
                GLASS_STRONG,
                "shadow-lift mac:bg-glass-strong/70",
                // 8 px margin + 70 px clears the traffic lights, which end at x = 72.
                "max-[900px]:w-[70px] max-[900px]:px-2 max-[900px]:pb-2",
            )}
        >
            <div className="hidden h-[26px] shrink-0 mac:block max-[900px]:h-[30px]" data-tauri-drag-region />

            <div
                className="flex items-center gap-2.5 px-1.5 pt-1.5 pb-3.5 font-display text-[17px] font-bold tracking-[-.02em] max-[900px]:justify-center max-[900px]:px-0"
                data-tauri-drag-region
            >
                <img src="/mark.svg" width={28} height={28} alt="" draggable={false} className="shrink-0 rounded-ctl shadow-glow" />
                <span className={WIDE_ONLY}>Pheasa</span>
            </div>

            <button
                type="button"
                onClick={onCommand}
                title="Search and run commands"
                className={cx(
                    "mb-2.5 flex h-8 items-center gap-2 rounded-full border-0 bg-fill pr-1.5 pl-[11px] text-left text-muted",
                    "shadow-[inset_0_0_0_.5px_var(--stroke)] transition-[background,transform] duration-250 ease-bounce",
                    "hover:bg-fill-hover hover:text-fg active:scale-97 max-[900px]:justify-center max-[900px]:p-0",
                )}
            >
                <Search size={14} />
                <span className={cx("min-w-0 flex-1", WIDE_ONLY)}>Search</span>
                <Kbd className={cx("rounded-full px-[7px] bg-surface-hi shadow-soft inset-shadow-specular", WIDE_ONLY)}>{MOD}K</Kbd>
            </button>

            {PAGES.map(({ id, label, icon: Icon, tile }) => {
                const active = view === id;

                return (
                    <button
                        key={id}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => onChange(id)}
                        title={label}
                        className={cx(
                            "relative flex h-[34px] items-center gap-2.5 rounded-ctl border-0 pr-2 pl-[5px] text-left text-fg",
                            "transition-[background,box-shadow,transform] duration-250 ease-bounce active:scale-97",
                            "max-[900px]:justify-center max-[900px]:p-0",
                            active
                                ? "bg-accent/15 font-semibold shadow-[inset_0_0_0_.5px_color-mix(in_srgb,var(--accent)_22%,transparent)]"
                                : "bg-transparent hover:bg-fill",
                        )}
                    >
                        {/* Coloured icon tile, like System Settings. */}
                        <span
                            className={cx(
                                "inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] text-white",
                                "bg-[linear-gradient(180deg,rgba(255,255,255,.28),transparent_55%),linear-gradient(180deg,color-mix(in_srgb,var(--tile)_80%,#fff),var(--tile))]",
                                "shadow-[inset_0_.5px_0_rgba(255,255,255,.5),inset_0_0_0_.5px_rgba(0,0,0,.06),0_1px_3px_color-mix(in_srgb,var(--tile)_45%,transparent)]",
                            )}
                            style={{ "--tile": tile } as React.CSSProperties}
                        >
                            <Icon size={14} strokeWidth={2.2} />
                        </span>
                        <span className={WIDE_ONLY}>{label}</span>
                    </button>
                );
            })}

            {/* A long runtime job stays visible from every page. */}
            {job.busy ? (
                <button
                    type="button"
                    onClick={() => onChange("storage")}
                    title="Show progress in Storage"
                    className={cx(
                        "relative mt-auto flex items-center gap-2.5 overflow-hidden rounded-[10px] border-0 px-3 pt-2.5 pb-[13px] text-left text-small text-fg",
                        "bg-accent/12 shadow-[inset_0_0_0_.5px_color-mix(in_srgb,var(--accent)_24%,transparent)] animate-rise",
                        "transition-[background,transform] duration-250 ease-bounce hover:bg-accent/18 active:scale-98",
                        "max-[900px]:justify-center max-[900px]:px-0",
                    )}
                >
                    <Loader size={14} className="shrink-0 animate-spin text-accent" />
                    <span className={cx("min-w-0 flex-1", WIDE_ONLY)}>
                        <strong className="block font-semibold">{JOB_LABEL[job.busy]}</strong>
                        <small className="block truncate text-tiny text-muted">{job.log[job.log.length - 1] ?? "Starting"}</small>
                    </span>
                    <span className={cx("text-small text-muted tabular-nums", WIDE_ONLY)}>{elapsed}</span>
                    <IndeterminateBar />
                </button>
            ) : null}

            <div
                className={cx(
                    "flex flex-col gap-1 rounded-[10px] bg-fill p-3 text-tiny text-muted shadow-[inset_0_0_0_.5px_var(--stroke)]",
                    job.busy ? "mt-2" : "mt-auto",
                    WIDE_ONLY,
                )}
            >
                {device ? (
                    <span className="inline-flex items-center gap-1.5 font-medium text-fg">
                        <span className="size-1.5 rounded-full bg-good shadow-[0_0_0_3px_color-mix(in_srgb,var(--good)_22%,transparent)]" />
                        Running on {device}
                    </span>
                ) : null}
                <span>Start or stop: {MOD}↩</span>
                <span>All commands: {MOD}K</span>
            </div>
        </nav>
    );
}
