import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CircleCheck, Download, Languages, Loader, Sparkles } from "lucide-react";

import { useDownloads } from "../hooks/useDownloads";
import { api, formatBytes } from "../lib/api";
import { AUTO_LANGUAGE, LANGUAGES } from "../lib/types";
import type { Recommendation, Settings } from "../lib/types";
import { LevelTest } from "./SettingsView";
import { ACCENT_FILL, Button, Checkbox, cx, GLASS_STRONG, Hint, ProgressBar, Select, SURFACE, TextInput } from "./ui";

interface Props {
    settings : Settings;
    onChange : (settings: Settings) => void;
    onFinish : () => void;
}

const STEPS = ["Languages", "Listening", "Translation", "Audio", "Ready"];

const TITLE = "m-0 font-display text-[24px] font-bold tracking-[-.02em]";

/** Four short steps on first launch. */
export function Onboarding({ settings, onChange, onFinish }: Props) {
    const [step, setStep]       = useState(0);
    const [stt, setStt]         = useState<Recommendation[]>([]);
    const [mt, setMt]           = useState<Recommendation[]>([]);
    const [runtimeOk, setRuntimeOk] = useState(false);

    const refresh = useCallback(() => {
        api.recommended("stt", settings.source_lang, settings.target_lang).then(setStt).catch(() => undefined);
        api.recommended("translation", settings.source_lang, settings.target_lang).then(setMt).catch(() => undefined);
        api.runtimeStatus().then((r) => setRuntimeOk(r.ready)).catch(() => undefined);
    }, [settings.source_lang, settings.target_lang]);

    const downloads = useDownloads(refresh);

    useEffect(refresh, [refresh]);

    const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });

    const row = (rec: Recommendation, pick: () => void, chosen: boolean) => {
        const p   = downloads.progress[rec.id];
        const pct = p && p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;
        const blocked = rec.backend !== "native" && !runtimeOk;

        return (
            <div key={rec.id} className={cx("relative mb-2 flex shrink-0 items-center gap-3 rounded-row px-4 py-3 animate-rise", SURFACE)}>
                <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{rec.id}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-small text-muted">
                        <span>about {formatBytes(rec.size_bytes)}</span>
                        <span>{rec.note}</span>
                    </div>
                    {p ? <ProgressBar value={pct / 100} /> : null}
                </div>

                {p ? (
                    <Button disabled><Loader size={16} className="animate-spin" /><span>{pct.toFixed(0)}%</span></Button>
                ) : rec.installed ? (
                    <Button variant={chosen ? "primary" : "default"} onClick={pick}>
                        <CircleCheck size={16} /><span>{chosen ? "Chosen" : "Use"}</span>
                    </Button>
                ) : blocked ? (
                    <Button disabled title="Set up the Python runtime in Storage later"><span>Needs Python</span></Button>
                ) : (
                    <Button onClick={() => downloads.start(rec.id, rec.task, rec.backend)}>
                        <Download size={16} /><span>Download</span>
                    </Button>
                )}
            </div>
        );
    };

    const sameLang = settings.source_lang === settings.target_lang;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/55 backdrop-blur-2xl backdrop-saturate-160 animate-fade">
            <div className={cx("relative flex max-h-[88vh] w-[min(560px,92vw)] flex-col gap-3 overflow-auto rounded-pane p-[30px] animate-pop rim", GLASS_STRONG)}>
                <div className="flex flex-wrap gap-1.5 text-tiny text-muted">
                    {STEPS.map((label, i) => (
                        <span
                            key={label}
                            className={cx(
                                "rounded-full px-2.5 py-[3px] transition-[background,color] duration-250 ease-spring",
                                i === step ? ACCENT_FILL : i < step ? "bg-fill text-fg" : "bg-fill",
                            )}
                        >
                            {label}
                        </span>
                    ))}
                </div>

                {step === 0 ? (
                    <>
                        <Languages size={28} className="shrink-0 text-good" />
                        <h2 className={TITLE}>Welcome to Pheasa</h2>
                        <p className="m-0 text-muted">Which language do you hear, and which do you want to read?</p>

                        <div className="flex flex-col gap-2">
                            <Select value={settings.source_lang} onChange={(e) => set("source_lang", e.target.value)}>
                                <option value={AUTO_LANGUAGE.code}>{AUTO_LANGUAGE.name}</option>
                                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                            </Select>

                            <Select value={settings.target_lang} onChange={(e) => set("target_lang", e.target.value)}>
                                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                            </Select>
                        </div>
                    </>
                ) : null}

                {step === 1 ? (
                    <>
                        <h2 className={TITLE}>Speech recognition</h2>
                        <p className="m-0 text-muted">One download, then it works offline. Larger is more accurate but slower.</p>
                        {stt.map((rec) => row(rec, () => set("stt_model", rec.id), settings.stt_model === rec.id))}
                        {downloads.error ? <Hint>{downloads.error}</Hint> : null}
                    </>
                ) : null}

                {step === 2 ? (
                    <>
                        <h2 className={TITLE}>Translation</h2>

                        {sameLang ? (
                            <p className="m-0 text-muted">Both languages are the same, so nothing needs translating. You can skip this step.</p>
                        ) : (
                            <>
                                <p className="m-0 text-muted">Run a model on this computer, or use a cloud service you already have a key for.</p>

                                <div className="flex flex-col gap-2">
                                    <Select value={settings.mt_backend} onChange={(e) => set("mt_backend", e.target.value as Settings["mt_backend"])}>
                                        <option value="local">On this computer (offline)</option>
                                        <option value="cloud">Cloud service (OpenAI-compatible)</option>
                                    </Select>
                                </div>

                                {settings.mt_backend === "local" ? (
                                    mt.map((rec) => row(rec, () => set("mt_model", rec.id), settings.mt_model === rec.id))
                                ) : (
                                    <div className="flex flex-col gap-2">
                                        <TextInput type="text" placeholder="Base URL" value={settings.cloud.base_url}
                                            onChange={(e) => set("cloud", { ...settings.cloud, base_url: e.target.value })} />
                                        <TextInput type="password" placeholder="API key" value={settings.cloud.api_key}
                                            onChange={(e) => set("cloud", { ...settings.cloud, api_key: e.target.value })} />
                                        <TextInput type="text" placeholder="Model" value={settings.cloud.model}
                                            onChange={(e) => set("cloud", { ...settings.cloud, model: e.target.value })} />
                                    </div>
                                )}
                            </>
                        )}
                    </>
                ) : null}

                {step === 3 ? (
                    <>
                        <h2 className={TITLE}>Check the audio</h2>
                        <p className="m-0 text-muted">Turn on the test, then speak or play a video. The bars should move.</p>

                        <div className="flex flex-col gap-2">
                            <label className="flex items-center gap-2"><Checkbox checked={settings.capture_mic} onChange={(e) => set("capture_mic", e.target.checked)} /> Microphone</label>
                            <label className="flex items-center gap-2"><Checkbox checked={settings.capture_system} onChange={(e) => set("capture_system", e.target.checked)} /> System audio (the other side of a call)</label>
                        </div>

                        <LevelTest settings={settings} />
                    </>
                ) : null}

                {step === 4 ? (
                    <>
                        <Sparkles size={28} className="shrink-0 text-good" />
                        <h2 className={TITLE}>You are ready</h2>
                        <p className="m-0 text-muted">
                            Press Start on the Live page. Models, the Python runtime and saved
                            conversations can be removed any time in Storage.
                        </p>
                    </>
                ) : null}

                <div className="mt-2 flex shrink-0 gap-2">
                    <Button onClick={onFinish}>Skip</Button>
                    <div className="flex-1" />

                    {step > 0 ? (
                        <Button onClick={() => setStep(step - 1)}><ArrowLeft size={16} /><span>Back</span></Button>
                    ) : null}

                    {step < STEPS.length - 1 ? (
                        <Button variant="primary" onClick={() => setStep(step + 1)}>
                            <span>Next</span><ArrowRight size={16} />
                        </Button>
                    ) : (
                        <Button variant="primary" onClick={onFinish}><span>Finish</span></Button>
                    )}
                </div>
            </div>
        </div>
    );
}
