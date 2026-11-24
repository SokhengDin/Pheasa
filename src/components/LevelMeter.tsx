import { Mic, Volume2 } from "lucide-react";

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
        <div className="meter" title={label ?? (source === "mic" ? "Microphone level" : "System audio level")}>
            <Icon size={14} />
            <div className="meter-track">
                <div className={`meter-fill ${shown > 0.92 ? "hot" : ""}`} style={{ width: `${shown * 100}%` }} />
            </div>
        </div>
    );
}
