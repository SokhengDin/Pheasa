import { Loader, Maximize2, Play, Square } from "lucide-react";

import type { EngineStatus, Settings, TranscriptLine } from "../lib/types";
import { speakerColor } from "../lib/prefs";
import { LevelMeter } from "./LevelMeter";

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
        <div className="compact">
            <div className="compact-bar" data-tauri-drag-region>
                {running ? (
                    <button className="icon-btn" onClick={onStop} title="Stop"><Square size={14} /></button>
                ) : (
                    <button className="icon-btn" onClick={onStart} disabled={loading || !settings.stt_model} title="Start">
                        {loading ? <Loader size={14} className="spin" /> : <Play size={14} />}
                    </button>
                )}

                <div className="grow" data-tauri-drag-region />

                {running && settings.capture_mic    ? <LevelMeter source="mic"    level={levels.mic}    /> : null}
                {running && settings.capture_system ? <LevelMeter source="system" level={levels.system} /> : null}

                <button className="icon-btn" onClick={onExpand} title="Back to the full window">
                    <Maximize2 size={14} />
                </button>
            </div>

            <div className="compact-body" data-tauri-drag-region>
                {last ? (
                    <>
                        <span className="compact-speaker" style={{ color: speakerColor(last.speaker) }}>{speaker}</span>
                        <div className="compact-text">{last.translation ?? last.text}</div>
                        {last.translation ? <div className="compact-orig">{last.text}</div> : null}
                    </>
                ) : (
                    <div className="compact-orig">{status.message}</div>
                )}
            </div>
        </div>
    );
}
