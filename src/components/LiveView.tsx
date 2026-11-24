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
import { Button, Callout, Chip, GLASS, GLASS_STRONG, IconButton, cx } from "./ui";

/** Status dot and text colour per engine state. */
const STATE_TONE: Record<string, { text: string; dot: string }> = {
    running : { text: "text-good",  dot: "bg-good animate-halo" },
    loading : { text: "text-muted", dot: "bg-warn animate-blink" },
    error   : { text: "text-bad",   dot: "bg-bad" },
};

const IDLE_TONE = { text: "text-muted", dot: "bg-faint" };

/** A select inside the language capsule: transparent until hovered. */
const LANG_SELECT = cx(
    "h-7 rounded-full border-0 bg-transparent px-3 font-medium outline-none transition-[background,box-shadow] duration-250 ease-spring",
    "enabled:hover:bg-surface-hi enabled:hover:shadow-soft focus-visible:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--accent)_42%,transparent)] disabled:opacity-45",
    "@max-[600px]:max-w-[140px] @max-[600px]:px-2",
);

/** The Start / Stop button tightens up on very narrow windows. */
const RECORD_NARROW = "@max-[600px]:h-10 @max-[600px]:min-w-0 @max-[600px]:px-[18px]";

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

    const tone = STATE_TONE[status.state] ?? IDLE_TONE;

    const swap = () =>
        onChange({ ...settings, source_lang: settings.target_lang, target_lang: settings.source_lang });

    return (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto animate-fade">
            {/* Language switch in the middle, status pill on the right. Equal side
                columns keep the switch truly centred. */}
            <header
                className={cx(
                    "sticky top-0 z-[5] grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-gutter pt-3 pb-2.5 mac:pt-3.5 scroll-edge",
                    "@max-[600px]:grid-cols-[minmax(0,1fr)_auto]",
                )}
                data-tauri-drag-region
            >
                <div className={cx("col-start-2 inline-flex h-8 items-center gap-0.5 rounded-full p-0.5 @max-[600px]:col-start-1 @max-[600px]:justify-self-center", GLASS)}>
                    <select
                        className={LANG_SELECT}
                        value={settings.source_lang}
                        disabled={busy}
                        onChange={(e) => onChange({ ...settings, source_lang: e.target.value })}
                        title="Language being spoken"
                    >
                        <option value={AUTO_LANGUAGE.code}>{AUTO_LANGUAGE.name}</option>
                        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                    </select>

                    <IconButton
                        className="text-accent enabled:hover:text-accent [&_svg]:transition-transform [&_svg]:duration-450 [&_svg]:ease-bounce enabled:hover:[&_svg]:rotate-180"
                        disabled={busy || auto}
                        onClick={swap}
                        title="Swap languages"
                    >
                        <ArrowRightLeft size={15} />
                    </IconButton>

                    <select
                        className={LANG_SELECT}
                        value={settings.target_lang}
                        disabled={busy}
                        onChange={(e) => onChange({ ...settings, target_lang: e.target.value })}
                        title="Translate into"
                    >
                        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                    </select>
                </div>

                {/* Status pill; on narrow windows only the dot, speed and meters stay. */}
                <div
                    className={cx(
                        "col-start-3 flex h-8 min-w-0 max-w-full items-center gap-2 justify-self-end rounded-full pr-1.5 pl-3 text-small font-medium",
                        "@max-[760px]:px-2.5 @max-[600px]:col-start-2",
                        GLASS,
                        tone.text,
                    )}
                    title={status.message}
                >
                    <span className={cx("size-2 shrink-0 rounded-full transition-[background] duration-250", tone.dot)} />
                    <span className="min-w-0 truncate @max-[760px]:hidden">{status.message}</span>

                    {status.device ? (
                        <Chip className="h-[22px] px-[9px] text-muted @max-[760px]:hidden">
                            <Cpu size={12} />
                            {status.device}
                        </Chip>
                    ) : null}

                    {running && perf ? (
                        <Chip className="h-[22px] px-[9px]" tone={speedVerdict(perf.rtf).tone} title={speedVerdict(perf.rtf).hint}>
                            <Gauge size={12} />
                            {speedVerdict(perf.rtf).label} ({perf.rtf.toFixed(2)}x)
                        </Chip>
                    ) : null}

                    {running && settings.capture_mic    ? <LevelMeter source="mic"    level={levels.mic}    /> : null}
                    {running && settings.capture_system ? <LevelMeter source="system" level={levels.system} /> : null}
                </div>
            </header>

            {needsStt ? (
                <Callout
                    className="mx-gutter my-1.5"
                    icon={Boxes}
                    title="Choose a speech-to-text model"
                    action={<Button variant="primary" onClick={() => onOpen("models")}>Open Models</Button>}
                >
                    Download a Whisper model once, and it works offline from then on.
                </Callout>
            ) : null}

            {!needsStt ? <PairSuggest settings={settings} onChange={onChange} onOpen={onOpen} onNeed={setPairWrong} /> : null}

            {running && noSystem ? (
                <Callout
                    className="mx-gutter my-1.5"
                    tone="warn"
                    icon={Volume2}
                    title="No system audio yet"
                    action={<Button onClick={() => onOpen("settings")}>Settings</Button>}
                >
                    The other side of the call is not reaching the app. Play something and watch the speaker meter.
                    On a Mac, allow System Audio Recording for this app (or for Terminal in development) in
                    System Settings, Privacy and Security, then restart it.
                </Callout>
            ) : null}

            {autoLocal ? (
                <Callout
                    className="mx-gutter my-1.5"
                    tone="warn"
                    icon={TriangleAlert}
                    title="Automatic detection needs the cloud backend"
                    action={<Button onClick={() => onOpen("settings")}>Settings</Button>}
                >
                    Pick a source language, or switch translation to the cloud in Settings.
                </Callout>
            ) : null}

            {running && perf && perf.rtf >= 1 ? (
                <Callout
                    className="mx-gutter my-1.5"
                    tone="warn"
                    icon={Gauge}
                    title="Subtitles are falling behind"
                    action={<Button onClick={() => onOpen("models")}>Open Models</Button>}
                >
                    {speedVerdict(perf.rtf).hint}
                </Callout>
            ) : null}

            <TranscriptList lines={lines} names={names} onRename={onRename} onRemember={onRemember} listening={running} docked />

            {/* Floating glass dock: subtitle window on the left, the main action in
                the middle, transcript actions on the right. The transcript runs under it. */}
            <div
                role="toolbar"
                aria-label="Translator controls"
                className={cx(
                    "sticky bottom-[18px] z-[6] -mt-[78px] flex shrink-0 items-center gap-2.5 self-center rounded-full p-[7px] rim animate-dock",
                    "@max-[600px]:gap-1 @max-[600px]:p-[5px]",
                    GLASS_STRONG,
                )}
            >
                <div className="flex items-center gap-0.5 px-0.5">
                    <IconButton
                        size="lg"
                        active={overlay}
                        onClick={() => onOverlay(!overlay)}
                        aria-pressed={overlay}
                        title={overlay ? "Hide the floating subtitle window" : "Floating subtitle window, drag it anywhere"}
                    >
                        <PictureInPicture2 size={17} />
                    </IconButton>

                    <IconButton
                        size="lg"
                        active={prefs.locked}
                        onClick={() => setPrefs({ ...prefs, locked: !prefs.locked })}
                        disabled={!overlay}
                        aria-pressed={prefs.locked}
                        title={prefs.locked ? "Subtitles ignore the mouse. Click to move them again" : "Let the mouse pass through the subtitles"}
                    >
                        {prefs.locked ? <Lock size={17} /> : <LockOpen size={17} />}
                    </IconButton>
                </div>

                {running ? (
                    <Button variant="danger" size="xl" className={RECORD_NARROW} onClick={onStop} title="Stop translating">
                        <Square size={14} fill="currentColor" />
                        <span>Stop</span>
                    </Button>
                ) : (
                    <Button
                        variant="primary"
                        size="xl"
                        className={RECORD_NARROW}
                        onClick={onStart}
                        disabled={loading || needsStt || needsMt || autoLocal || pairWrong}
                        title={needsMt || pairWrong ? "Choose a translation model for this language pair first" : needsStt ? "Choose a speech-to-text model first" : autoLocal ? "Automatic detection needs the cloud backend" : "Start translating"}
                    >
                        {loading ? <Loader size={16} className="animate-spin" /> : <Play size={15} fill="currentColor" />}
                        <span>{loading ? "Loading" : "Start"}</span>
                    </Button>
                )}

                <div className="flex items-center gap-0.5 px-0.5">
                    <ExportMenu lines={lines} names={names} settings={settings} />

                    <IconButton size="lg" onClick={onSave} disabled={lines.length === 0} title="Save this conversation to History">
                        <Save size={17} />
                    </IconButton>

                    <IconButton size="lg" onClick={onCompact} title="Small always-on-top window">
                        <Minimize2 size={17} />
                    </IconButton>

                    <IconButton size="lg" onClick={onClear} disabled={lines.length === 0} title="Clear the transcript">
                        <Trash2 size={17} />
                    </IconButton>
                </div>
            </div>
        </div>
    );
}
