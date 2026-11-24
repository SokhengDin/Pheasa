import { Mic, Volume2 } from "lucide-react";

import { cx } from "./ui";

interface Props {
    source : "mic" | "system";
    level  : number;
    label? : string;
}

/** Input level bar. `level` is the recent peak, 0 to 1. */
export function LevelMeter({ source, level, label }: Props) {
    // Speech peaks sit low on a linear scale, so show it on a gentle curve.
    const shown = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.1);
    const Icon  = source === "mic" ? Mic : Volume2;

    return (
        <div className="flex min-w-[76px] items-center gap-1.5 text-muted @max-[760px]:min-w-14" title={label ?? (source === "mic" ? "Microphone level" : "System audio level")}>
            <Icon size={14} className="shrink-0" />
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill-hover">
                <div
                    className={cx(
                        "h-full rounded-full transition-[width] duration-75 ease-linear",
                        shown > 0.92
                            ? "bg-linear-to-r from-warn to-bad"
                            : "bg-[linear-gradient(90deg,var(--good),color-mix(in_srgb,var(--good)_40%,var(--accent-2)))]",
                    )}
                    style={{ width: `${shown * 100}%` }}
                />
            </div>
        </div>
    );
}
