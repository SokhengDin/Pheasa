import { useEffect, useRef, useState } from "react";

import {
    ArrowRightLeft,
    Boxes,
    Cpu,
    Gauge,
    Minimize2,
    Save,
    Loader,
    Lock,
    LockOpen,
    PictureInPicture2,
    Play,
    Square,
    Volume2,
    Trash2,
    TriangleAlert,
} from "lucide-react";

import { OVERLAY_DEFAULTS, OVERLAY_KEY, usePersisted } from "../lib/prefs";
import { AUTO_LANGUAGE, LANGUAGES } from "../lib/types";
import type { EngineStatus, Perf, Settings, TranscriptLine } from "../lib/types";
import { ExportMenu } from "./ExportMenu";
import { LevelMeter } from "./LevelMeter";
import { PairSuggest } from "./PairSuggest";
import { TranscriptList } from "./TranscriptList";

interface Props {
    settings : Settings;
    status   : EngineStatus;
    lines    : TranscriptLine[];
    levels   : Record<string, number>;
    perf     : Perf | null;
    names    : Record<string, string>;
    onRename : (speaker: string, name: string) => void;
    onRemember: (speaker: string, name: string) => void;
    onChange : (settings: Settings) => void;
    onStart  : () => void;
    onStop   : () => void;
    onClear  : () => void;
    onSave   : () => void;
    onCompact: () => void;
    overlay  : boolean;
    onOverlay: (on: boolean) => void;
    onOpen   : (view: "models" | "settings" | "storage") => void;
}

/** Speed verdict from the real-time factor: seconds of work per second of audio. */
function speedVerdict(rtf: number): { tone: "good" | "warn" | "bad"; label: string; hint: string } {
    if (rtf < 0.6) return { tone: "good", label: "Real time", hint: "Subtitles keep up with speech." };
    if (rtf < 1)   return { tone: "warn", label: "Keeping up", hint: "Close to the limit. Long sentences may lag." };

    return {
        tone  : "bad",
        label : "Too slow",
        hint  : "Subtitles fall behind speech. Use a smaller model, or run on a GPU (Settings, Compute).",
    };
}

export function LiveView({ settings, status, lines, levels, perf, names, onRename, onRemember, onChange, onStart, onStop, onClear, onSave, onCompact, overlay, onOverlay, onOpen }: Props) {
    const [prefs, setPrefs]           = usePersisted(OVERLAY_KEY, OVERLAY_DEFAULTS);

    const running = status.state === "running";
    const loading = status.state === "loading";
    const busy    = running || loading;
    const auto    = settings.source_lang === "auto";

    const sameLang    = settings.source_lang === settings.target_lang;
    const needsStt    = !settings.stt_model;
    const needsMt     = !sameLang && settings.mt_backend === "local" && !settings.mt_model;
    const autoLocal   = auto && settings.mt_backend === "local";

    // Warn when system audio is on but nothing has come through for a while.
    const heard                       = useRef(false);
    const [noSystem, setNoSystem]     = useState(false);
    const [pairWrong, setPairWrong]   = useState(false);

    useEffect(() => {
        if ((levels.system ?? 0) > 0.01) {
            heard.current = true;
            setNoSystem(false);
        }
    }, [levels.system]);

    useEffect(() => {
        heard.current = false;
        setNoSystem(false);

        if (!running || !settings.capture_system) return;

        const timer = window.setTimeout(() => setNoSystem(!heard.current), 10000);

        return () => window.clearTimeout(timer);
    }, [running, settings.capture_system]);

    const swap = () =>
        onChange({ ...settings, source_lang: settings.target_lang, target_lang: settings.source_lang });

    return (
        <div className="view">
            <header className="toolbar">
                <select
                    value={settings.source_lang}
                    disabled={busy}
                    onChange={(e) => onChange({ ...settings, source_lang: e.target.value })}
                >
                    <option value={AUTO_LANGUAGE.code}>{AUTO_LANGUAGE.name}</option>
                    {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>

                <button className="icon-btn" disabled={busy || auto} onClick={swap} title="Swap languages">
                    <ArrowRightLeft size={16} />
                </button>

                <select
                    value={settings.target_lang}
                    disabled={busy}
                    onChange={(e) => onChange({ ...settings, target_lang: e.target.value })}
                >
                    {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>

                <div className="spacer" />

                <button
                    className={`btn ${overlay ? "primary" : ""}`}
                    onClick={() => onOverlay(!overlay)}
                    title="Floating subtitle window, drag it anywhere"
                >
                    <PictureInPicture2 size={16} />
                    <span>Subtitles</span>
                </button>

                {overlay ? (
                    <button
                        className={`btn ${prefs.locked ? "primary" : ""}`}
                        onClick={() => setPrefs({ ...prefs, locked: !prefs.locked })}
                        title={prefs.locked ? "Subtitles ignore the mouse. Click to move them again" : "Let the mouse pass through the subtitles"}
                    >
                        {prefs.locked ? <Lock size={16} /> : <LockOpen size={16} />}
                        <span>{prefs.locked ? "Locked" : "Movable"}</span>
                    </button>
                ) : null}

                <ExportMenu lines={lines} names={names} settings={settings} />

                <button className="icon-btn" onClick={onSave} disabled={lines.length === 0} title="Save this conversation to History">
                    <Save size={16} />
                </button>

                <button className="icon-btn" onClick={onCompact} title="Small always-on-top window">
                    <Minimize2 size={16} />
                </button>

                <button className="btn" onClick={onClear} disabled={lines.length === 0} title="Clear the transcript">
                    <Trash2 size={16} />
                    <span>Clear</span>
                </button>

                {running ? (
                    <button className="btn danger" onClick={onStop}>
                        <Square size={16} />
                        <span>Stop</span>
                    </button>
                ) : (
                    <button
                        className="btn primary"
                        onClick={onStart}
                        disabled={loading || needsStt || needsMt || autoLocal || pairWrong}
                        title={needsMt || pairWrong ? "Choose a translation model for this language pair first" : needsStt ? "Choose a speech-to-text model first" : autoLocal ? "Automatic detection needs the cloud backend" : "Start translating"}
                    >
                        {loading ? <Loader size={16} className="spin" /> : <Play size={16} />}
                        <span>{loading ? "Loading" : "Start"}</span>
                    </button>
                )}
            </header>

            {needsStt ? (
                <div className="callout">
                    <Boxes size={20} />
                    <div className="grow">
                        <strong>Choose a speech-to-text model</strong>
                        <div className="muted">Download a Whisper model once, and it works offline from then on.</div>
                    </div>
                    <button className="btn primary" onClick={() => onOpen("models")}>Open Models</button>
                </div>
            ) : null}

            {!needsStt ? <PairSuggest settings={settings} onChange={onChange} onOpen={onOpen} onNeed={setPairWrong} /> : null}

            {running && noSystem ? (
                <div className="callout warn">
                    <Volume2 size={20} />
                    <div className="grow">
                        <strong>No system audio yet</strong>
                        <div className="muted">
                            The other side of the call is not reaching the app. Play something and watch the speaker meter.
                            On a Mac, allow System Audio Recording for this app (or for Terminal in development) in
                            System Settings, Privacy and Security, then restart it.
                        </div>
                    </div>
                    <button className="btn" onClick={() => onOpen("settings")}>Settings</button>
                </div>
            ) : null}

            {autoLocal ? (
                <div className="callout warn">
                    <TriangleAlert size={20} />
                    <div className="grow">
                        <strong>Automatic detection needs the cloud backend</strong>
                        <div className="muted">Pick a source language, or switch translation to the cloud in Settings.</div>
                    </div>
                    <button className="btn" onClick={() => onOpen("settings")}>Settings</button>
                </div>
            ) : null}

            <div className={`status ${status.state}`}>
                <span className="dot" />
                <span>{status.message}</span>

                {status.device ? (
                    <span className="chip">
                        <Cpu size={12} />
                        {status.device}
                    </span>
                ) : null}

                {running && perf ? (
                    <span className={`chip ${speedVerdict(perf.rtf).tone}`} title={speedVerdict(perf.rtf).hint}>
                        <Gauge size={12} />
                        {speedVerdict(perf.rtf).label} ({perf.rtf.toFixed(2)}x)
                    </span>
                ) : null}

                <div className="spacer" />

                {running && settings.capture_mic    ? <LevelMeter source="mic"    level={levels.mic}    /> : null}
                {running && settings.capture_system ? <LevelMeter source="system" level={levels.system} /> : null}
            </div>

            {running && perf && perf.rtf >= 1 ? (
                <div className="callout warn">
                    <Gauge size={20} />
                    <div className="grow">
                        <strong>Subtitles are falling behind</strong>
                        <div className="muted">{speedVerdict(perf.rtf).hint}</div>
                    </div>
                    <button className="btn" onClick={() => onOpen("models")}>Open Models</button>
                </div>
            ) : null}

            <TranscriptList lines={lines} names={names} onRename={onRename} onRemember={onRemember} listening={running} />
        </div>
    );
}
