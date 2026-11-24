import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, CircleOff, Plus, Trash2 } from "lucide-react";

import { api, errorText } from "../lib/api";
import { FONT_STACKS, IS_MAC, OVERLAY_DEFAULTS, OVERLAY_KEY, OVERLAY_PRESETS, usePersisted } from "../lib/prefs";
import type { FontFamily } from "../lib/prefs";
import { THEMES, type Theme } from "../lib/theme";
import type { AudioDeviceInfo, AudioLevel, ComputeDevice, ModelMeta, Settings } from "../lib/types";
import { LevelMeter } from "./LevelMeter";
import { Button, Card, Checkbox, Field, Hint, IconButton, PageHeader, Range, Segmented, Select, TextInput, cx } from "./ui";
import { VoicesPanel } from "./VoicesPanel";

interface Props {
    settings : Settings;
    onChange : (settings: Settings) => void;
    theme    : Theme;
    onTheme  : (theme: Theme) => void;
}

/** A hint directly below a Field row gets the same hairline separator. */
const AFTER_FIELD = "border-separator [[data-field]+&]:border-t-[.5px]";

/** Opens the inputs without transcribing, so the person can see sound arrive. */
export function LevelTest({ settings }: { settings: Settings }) {
    const [on, setOn]         = useState(false);
    const [levels, setLevels] = useState({ mic: 0, system: 0 });
    const [error, setError]   = useState<string | null>(null);

    useEffect(() => {
        if (!on) return;

        const unlisten = listen<AudioLevel>("audio-level", (event) =>
            setLevels((prev) => ({ ...prev, [event.payload.source]: event.payload.peak })));

        const fade = window.setInterval(() => setLevels((p) => ({ mic: p.mic * 0.8, system: p.system * 0.8 })), 100);

        return () => {
            unlisten.then((fn) => fn());
            window.clearInterval(fade);
        };
    }, [on]);

    // Release the devices when leaving the page.
    useEffect(() => () => { api.stopMonitor().catch(() => undefined); }, []);

    const toggle = async () => {
        setError(null);

        try {
            if (on) {
                await api.stopMonitor();
                setOn(false);
            } else {
                await api.saveSettings(settings);
                await api.startMonitor();
                setOn(true);
            }
        } catch (err) {
            setError(errorText(err));
        }
    };

    return (
        <>
            <Field label="Level test" detail="Speak, or play a video, and watch the bars move" wide>
                <Button variant={on ? "primary" : "default"} className="w-auto!" onClick={toggle}>{on ? "Stop test" : "Test inputs"}</Button>
            </Field>

            {on ? (
                <div className="flex flex-col border-t-[.5px] border-separator">
                    {settings.capture_mic    ? <LevelMeter source="mic"    level={levels.mic}    /> : null}
                    {settings.capture_system ? <LevelMeter source="system" level={levels.system} /> : null}
                </div>
            ) : null}

            {error ? <Hint className={AFTER_FIELD}>{error}</Hint> : null}
        </>
    );
}

export function SettingsView({ settings, onChange, theme, onTheme }: Props) {
    const [compute, setCompute]     = useState<ComputeDevice[]>([]);
    const [audio, setAudio]         = useState<AudioDeviceInfo[]>([]);
    const [installed, setInstalled] = useState<ModelMeta[]>([]);
    const [overlay, setOverlay]     = usePersisted(OVERLAY_KEY, OVERLAY_DEFAULTS);

    useEffect(() => {
        api.computeDevices().then(setCompute).catch(() => undefined);
        api.audioDevices().then(setAudio).catch(() => undefined);
        api.listInstalled(null).then(setInstalled).catch(() => undefined);
    }, []);

    const ofTask = (task: ModelMeta["task"]) => installed.filter((m) => m.task === task);

    const setGlossary = (index: number, key: "from" | "to", value: string) =>
        onChange({
            ...settings,
            glossary: settings.glossary.map((entry, i) => (i === index ? { ...entry, [key]: value } : entry)),
        });

    const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
        onChange({ ...settings, [key]: value });

    const inputs  = audio.filter((d) => d.input);
    const outputs = audio.filter((d) => d.output || /monitor/i.test(d.name));

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[22px] overflow-y-auto px-gutter pt-6 pb-12 [--col:760px] animate-fade *:shrink-0">
            <PageHeader title="Settings">Changes save automatically.</PageHeader>

            <Card title="Appearance">
                <Field label="Theme" detail="System follows the macOS or Windows setting. The subtitle window always stays dark.">
                    <Segmented options={THEMES} value={theme} onChange={onTheme} label="Theme" />
                </Field>
            </Card>

            <Card title="Compute">
                <Field label="Run models on" detail={IS_MAC ? "Automatic uses the Apple GPU when it can (MLX models always do), else the CPU" : "Automatic picks CUDA, then the CPU"} wide>
                    <Select value={settings.device} onChange={(e) => set("device", e.target.value as Settings["device"])}>
                        <option value="auto">Automatic</option>
                        <option value="cpu">CPU</option>
                        {IS_MAC ? null : <option value="cuda">NVIDIA GPU (CUDA)</option>}
                        {IS_MAC ? <option value="metal">Apple GPU (Metal)</option> : null}
                    </Select>
                </Field>

                <ul className="m-0 list-none p-0">
                    {compute.map((d) => (
                        <li
                            key={d.id}
                            className={cx("flex justify-between gap-3 border-t-[.5px] border-separator px-3.5 py-2", !d.available && "text-muted")}
                        >
                            <strong className="inline-flex items-center gap-2 font-medium">
                                {d.available ? <CircleCheck size={14} className="text-good" /> : <CircleOff size={14} />}
                                {d.label}
                            </strong>
                            <span className="text-right text-muted">{d.note}</span>
                        </li>
                    ))}
                </ul>
            </Card>

            <Card title="Translation">
                <Field label="Backend" detail="Local works offline. Cloud handles any language pair" wide>
                    <Select value={settings.mt_backend} onChange={(e) => set("mt_backend", e.target.value as Settings["mt_backend"])}>
                        <option value="local">Local, offline</option>
                        <option value="cloud">Cloud (OpenAI-compatible API)</option>
                    </Select>
                </Field>

                {settings.mt_backend === "cloud" ? (
                    <>
                        <Field label="Base URL" wide>
                            <TextInput
                                value={settings.cloud.base_url}
                                placeholder="https://api.openai.com/v1"
                                onChange={(e) => set("cloud", { ...settings.cloud, base_url: e.target.value })}
                            />
                        </Field>

                        <Field label="API key" wide>
                            <TextInput
                                type="password"
                                value={settings.cloud.api_key}
                                onChange={(e) => set("cloud", { ...settings.cloud, api_key: e.target.value })}
                            />
                        </Field>

                        <Field label="Model" wide>
                            <TextInput
                                value={settings.cloud.model}
                                onChange={(e) => set("cloud", { ...settings.cloud, model: e.target.value })}
                            />
                        </Field>
                    </>
                ) : (
                    <>
                        <Field label="Model in use">
                            <span className="text-muted">{settings.mt_model ?? "None chosen, open Models"}</span>
                        </Field>

                        <Field label="Second step" detail="Translate through English: this model handles English to the target" wide>
                            <Select
                                value={settings.mt_model_2 ?? ""}
                                onChange={(e) => set("mt_model_2", e.target.value || null)}
                            >
                                <option value="">None (one model does it all)</option>
                                {ofTask("translation").map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                            </Select>
                        </Field>
                    </>
                )}
            </Card>

            <Card title="Audio">
                <Field label="Microphone" detail='Your voice, labelled "You"'>
                    <Checkbox
                        checked={settings.capture_mic}
                        onChange={(e) => set("capture_mic", e.target.checked)}
                    />
                </Field>

                <Field label="Microphone device" wide>
                    <Select
                        value={settings.mic_device ?? ""}
                        disabled={!settings.capture_mic}
                        onChange={(e) => set("mic_device", e.target.value || null)}
                    >
                        <option value="">Default microphone</option>
                        {inputs.map((d) => <option key={d.key} value={d.key}>{d.name} ({d.host})</option>)}
                    </Select>
                </Field>

                <Field label="System audio" detail="The other side of a call">
                    <Checkbox
                        checked={settings.capture_system}
                        onChange={(e) => set("capture_system", e.target.checked)}
                    />
                </Field>

                <Field label="System audio device" wide>
                    <Select
                        value={settings.system_device ?? ""}
                        disabled={!settings.capture_system}
                        onChange={(e) => set("system_device", e.target.value || null)}
                    >
                        <option value="">Default output or monitor</option>
                        {outputs.map((d) => <option key={d.key} value={d.key}>{d.name} ({d.host})</option>)}
                    </Select>
                </Field>

                <Field label="Detect speech with a neural model" detail="Silero VAD, fewer false starts. Needs the Python runtime (Storage)">
                    <Checkbox
                        checked={settings.neural_vad}
                        onChange={(e) => set("neural_vad", e.target.checked)}
                    />
                </Field>

                <Field label="Remove echo from the microphone" detail="Skips what the microphone picks up from your speakers, so the other side is not transcribed twice. Not needed with headphones">
                    <Checkbox
                        checked={settings.echo_guard}
                        onChange={(e) => set("echo_guard", e.target.checked)}
                    />
                </Field>

                <LevelTest settings={settings} />
            </Card>

            <Card title="Speakers">
                <Field label="Tell remote speakers apart" detail="With a speaker model, people you saved are named automatically">
                    <Checkbox
                        checked={settings.separate_remote_speakers}
                        onChange={(e) => set("separate_remote_speakers", e.target.checked)}
                    />
                </Field>

                <Field label="Speaker model" detail="Tells voices apart by embedding. Without one, a lighter built-in method is used" wide>
                    <Select
                        value={settings.speaker_model ?? ""}
                        onChange={(e) => set("speaker_model", e.target.value || null)}
                    >
                        <option value="">Built-in (voice colour)</option>
                        {ofTask("speaker").map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                    </Select>
                </Field>

                <Field label={`Sensitivity ${settings.speaker_threshold.toFixed(2)}`} detail="Lower splits voices more eagerly" wide>
                    <Range
                        min={0.2}
                        max={0.9}
                        step={0.05}
                        value={settings.speaker_threshold}
                        onChange={(e) => set("speaker_threshold", Number(e.target.value))}
                    />
                </Field>

                <Hint className={AFTER_FIELD}>
                    Without a speaker model, voices are only guessed and can swap or merge. With one, save
                    a person once and they are recognised by name in every meeting.
                </Hint>

                <VoicesPanel settings={settings} />
            </Card>

            <Card title="Voice output">
                <Field label="Speak the translation" detail="Reads what remote people say, in your language. Your own voice is never read back">
                    <Checkbox
                        checked={settings.speak_translation}
                        onChange={(e) => set("speak_translation", e.target.checked)}
                    />
                </Field>

                <Field label="Voice" detail="A text-to-speech model from Models" wide>
                    <Select
                        value={settings.tts_model ?? ""}
                        onChange={(e) => set("tts_model", e.target.value || null)}
                    >
                        <option value="">None</option>
                        {ofTask("tts").map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                    </Select>
                </Field>

                <Hint className={AFTER_FIELD}>
                    The app pauses listening while it speaks, so the voice is not heard again as input.
                    Wear headphones for the cleanest result.
                </Hint>
            </Card>

            <Card title="Glossary">
                <Hint>
                    Names and terms to translate your way. The left side is found in what was said
                    (any capitalisation), and replaced by the right side before translating. To keep a
                    name unchanged, put it on both sides.
                </Hint>

                {settings.glossary.map((entry, index) => (
                    <div key={index} className="mb-2 grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                        <TextInput
                            type="text"
                            className="w-full"
                            value={entry.from}
                            placeholder="Heard as"
                            onChange={(e) => setGlossary(index, "from", e.target.value)}
                        />
                        <TextInput
                            type="text"
                            className="w-full"
                            value={entry.to}
                            placeholder="Use instead"
                            onChange={(e) => setGlossary(index, "to", e.target.value)}
                        />
                        <IconButton
                            title="Remove"
                            onClick={() => onChange({ ...settings, glossary: settings.glossary.filter((_, i) => i !== index) })}
                        >
                            <Trash2 size={16} />
                        </IconButton>
                    </div>
                ))}

                <Button
                    onClick={() => onChange({ ...settings, glossary: [...settings.glossary, { from: "", to: "" }] })}
                >
                    <Plus size={16} />
                    <span>Add a term</span>
                </Button>
            </Card>

            <Card title="Subtitle window">
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 px-4 pt-1.5 pb-3.5">
                    {OVERLAY_PRESETS.map((preset) => (
                        <button
                            key={preset.id}
                            type="button"
                            className="flex cursor-pointer flex-col gap-0.5 rounded-[10px] border-0 bg-fill px-3 py-2.5 text-left text-fg shadow-[inset_0_0_0_.5px_var(--separator)] transition-[box-shadow,transform] duration-250 ease-bounce active:scale-97"
                            onClick={() => setOverlay({ ...overlay, ...preset.prefs })}
                        >
                            <span
                                className="mb-1.5 rounded-[6px] bg-[#111] px-2.5 py-2 text-lead"
                                style={{
                                    color      : preset.prefs.textColor,
                                    fontFamily : FONT_STACKS[preset.prefs.fontFamily as FontFamily],
                                    fontWeight : preset.prefs.bold ? 700 : 500,
                                    textShadow : preset.prefs.outline ? "0 0 3px #000, 0 0 3px #000" : "none",
                                }}
                            >
                                Hello there
                            </span>
                            <strong>{preset.label}</strong>
                            <small className="text-muted">{preset.hint}</small>
                        </button>
                    ))}
                </div>

                <Field label="Font" wide>
                    <Select
                        value={overlay.fontFamily}
                        onChange={(e) => setOverlay({ ...overlay, fontFamily: e.target.value as FontFamily })}
                    >
                        <option value="system">System</option>
                        <option value="serif">Serif</option>
                        <option value="rounded">Rounded</option>
                        <option value="mono">Monospace</option>
                    </Select>
                </Field>

                <Field label="Text colour">
                    <input
                        type="color"
                        value={overlay.textColor}
                        onChange={(e) => setOverlay({ ...overlay, textColor: e.target.value })}
                    />
                </Field>

                <Field label="Bold text">
                    <Checkbox
                        checked={overlay.bold}
                        onChange={(e) => setOverlay({ ...overlay, bold: e.target.checked })}
                    />
                </Field>

                <Field label="Outline" detail="Keeps text readable over bright video">
                    <Checkbox
                        checked={overlay.outline}
                        onChange={(e) => setOverlay({ ...overlay, outline: e.target.checked })}
                    />
                </Field>

                <Field label={`Background ${Math.round(overlay.opacity * 100)}%`} wide>
                    <Range
                        min={0}
                        max={1}
                        step={0.05}
                        value={overlay.opacity}
                        onChange={(e) => setOverlay({ ...overlay, opacity: Number(e.target.value) })}
                    />
                </Field>

                <Field label={`Text size ${overlay.fontSize}px`} wide>
                    <Range
                        min={12}
                        max={64}
                        step={2}
                        value={overlay.fontSize}
                        onChange={(e) => setOverlay({ ...overlay, fontSize: Number(e.target.value) })}
                    />
                </Field>

                <Field label={`Lines shown ${overlay.lines}`} wide>
                    <Range
                        min={1}
                        max={5}
                        step={1}
                        value={overlay.lines}
                        onChange={(e) => setOverlay({ ...overlay, lines: Number(e.target.value) })}
                    />
                </Field>

                <Field label="Show the original text">
                    <Checkbox
                        checked={overlay.showOriginal}
                        onChange={(e) => setOverlay({ ...overlay, showOriginal: e.target.checked })}
                    />
                </Field>

                <Field label="Show who is speaking">
                    <Checkbox
                        checked={overlay.showSpeaker}
                        onChange={(e) => setOverlay({ ...overlay, showSpeaker: e.target.checked })}
                    />
                </Field>

                <Hint className={AFTER_FIELD}>
                    Drag the subtitle window anywhere, on any screen. It remembers its place and
                    follows you across desktops. Resize it from the corner grip.
                </Hint>
            </Card>
        </div>
    );
}
