import { Loader, Maximize2, Play, Square } from "lucide-react";

import type { EngineStatus, Settings, TranscriptLine } from "../lib/types";
import { speakerColor } from "../lib/prefs";
import { LevelMeter } from "./LevelMeter";
import { IconButton } from "./ui";

interface Props {
    settings : Settings;
    status   : EngineStatus;
    lines    : TranscriptLine[];
    levels   : Record<string, number>;
    names    : Record<string, string>;
    onStart  : () => void;
    onStop   : () => void;
    onExpand : () => void;
}

/** Small always-on-top window: the latest subtitle and a start/stop button. */
export function CompactView({ settings, status, lines, levels, names, onStart, onStop, onExpand }: Props) {
    const running = status.state === "running";
    const loading = status.state === "loading";
    const last    = [...lines].reverse().find((l) => l.text);
    const speaker = last ? names[last.speaker] ?? last.speaker : "";

    return (
        // One small pane: controls on top (clear of the traffic lights), the latest line below.
        <div className="relative flex h-screen flex-col gap-1.5 bg-bg px-3 pt-2 pb-3 wash mac:bg-bg/70">
            <div className="flex items-center gap-2 pl-16" data-tauri-drag-region>
                {running ? (
                    <IconButton onClick={onStop} title="Stop"><Square size={14} /></IconButton>
                ) : (
                    <IconButton onClick={onStart} disabled={loading || !settings.stt_model} title="Start">
                        {loading ? <Loader size={14} className="animate-spin" /> : <Play size={14} />}
                    </IconButton>
                )}

                <div className="min-w-0 flex-1" data-tauri-drag-region />

                {running && settings.capture_mic    ? <LevelMeter source="mic"    level={levels.mic}    /> : null}
                {running && settings.capture_system ? <LevelMeter source="system" level={levels.system} /> : null}

                <IconButton onClick={onExpand} title="Back to the full window">
                    <Maximize2 size={14} />
                </IconButton>
            </div>

            <div className="flex flex-1 flex-col justify-center gap-0.5 overflow-hidden" data-tauri-drag-region>
                {last ? (
                    <>
                        <span className="text-tiny font-semibold" style={{ color: speakerColor(last.speaker) }}>{speaker}</span>
                        <div className="font-display text-[18px] leading-[1.25] font-semibold tracking-[-.01em]">{last.translation ?? last.text}</div>
                        {last.translation ? <div className="text-small text-muted">{last.text}</div> : null}
                    </>
                ) : (
                    <div className="text-small text-muted">{status.message}</div>
                )}
            </div>
        </div>
    );
}
