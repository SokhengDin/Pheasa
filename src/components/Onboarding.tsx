import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CircleCheck, Download, Languages, Loader, Sparkles } from "lucide-react";

import { useDownloads } from "../hooks/useDownloads";
import { api, formatBytes } from "../lib/api";
import { AUTO_LANGUAGE, LANGUAGES } from "../lib/types";
import type { Recommendation, Settings } from "../lib/types";
import { LevelTest } from "./SettingsView";

interface Props {
    settings : Settings;
    onChange : (settings: Settings) => void;
    onFinish : () => void;
}

const STEPS = ["Languages", "Listening", "Translation", "Audio", "Ready"];

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
            <div key={rec.id} className="row">
                <div className="grow">
                    <div className="name">{rec.id}</div>
                    <div className="meta">
                        <span>about {formatBytes(rec.size_bytes)}</span>
                        <span>{rec.note}</span>
                    </div>
                    {p ? <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div> : null}
                </div>

                {p ? (
                    <button className="btn" disabled><Loader size={16} className="spin" /><span>{pct.toFixed(0)}%</span></button>
                ) : rec.installed ? (
                    <button className={`btn ${chosen ? "primary" : ""}`} onClick={pick}>
                        <CircleCheck size={16} /><span>{chosen ? "Chosen" : "Use"}</span>
                    </button>
                ) : blocked ? (
                    <button className="btn" disabled title="Set up the Python runtime in Storage later"><span>Needs Python</span></button>
                ) : (
                    <button className="btn" onClick={() => downloads.start(rec.id, rec.task, rec.backend)}>
                        <Download size={16} /><span>Download</span>
                    </button>
                )}
            </div>
        );
    };

    const sameLang = settings.source_lang === settings.target_lang;

    return (
        <div className="onboard">
            <div className="onboard-card">
                <div className="onboard-steps">
                    {STEPS.map((label, i) => (
                        <span key={label} className={`onboard-step ${i === step ? "on" : i < step ? "past" : ""}`}>{label}</span>
                    ))}
                </div>

                {step === 0 ? (
                    <>
                        <Languages size={28} className="ok" />
                        <h2>Welcome to Pheasa</h2>
                        <p className="muted">Which language do you hear, and which do you want to read?</p>

                        <div className="fields">
                            <select value={settings.source_lang} onChange={(e) => set("source_lang", e.target.value)}>
                                <option value={AUTO_LANGUAGE.code}>{AUTO_LANGUAGE.name}</option>
                                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                            </select>

                            <select value={settings.target_lang} onChange={(e) => set("target_lang", e.target.value)}>
                                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                            </select>
                        </div>
                    </>
                ) : null}

                {step === 1 ? (
                    <>
                        <h2>Speech recognition</h2>
                        <p className="muted">One download, then it works offline. Larger is more accurate but slower.</p>
                        {stt.map((rec) => row(rec, () => set("stt_model", rec.id), settings.stt_model === rec.id))}
                        {downloads.error ? <p className="hint">{downloads.error}</p> : null}
                    </>
                ) : null}

                {step === 2 ? (
                    <>
                        <h2>Translation</h2>

                        {sameLang ? (
                            <p className="muted">Both languages are the same, so nothing needs translating. You can skip this step.</p>
                        ) : (
                            <>
                                <p className="muted">Run a model on this computer, or use a cloud service you already have a key for.</p>

                                <div className="fields">
                                    <select value={settings.mt_backend} onChange={(e) => set("mt_backend", e.target.value as Settings["mt_backend"])}>
                                        <option value="local">On this computer (offline)</option>
                                        <option value="cloud">Cloud service (OpenAI-compatible)</option>
                                    </select>
                                </div>

                                {settings.mt_backend === "local" ? (
                                    mt.map((rec) => row(rec, () => set("mt_model", rec.id), settings.mt_model === rec.id))
                                ) : (
                                    <div className="fields">
                                        <input type="text" placeholder="Base URL" value={settings.cloud.base_url}
                                            onChange={(e) => set("cloud", { ...settings.cloud, base_url: e.target.value })} />
                                        <input type="password" placeholder="API key" value={settings.cloud.api_key}
                                            onChange={(e) => set("cloud", { ...settings.cloud, api_key: e.target.value })} />
                                        <input type="text" placeholder="Model" value={settings.cloud.model}
                                            onChange={(e) => set("cloud", { ...settings.cloud, model: e.target.value })} />
                                    </div>
                                )}
                            </>
                        )}
                    </>
                ) : null}

                {step === 3 ? (
                    <>
                        <h2>Check the audio</h2>
                        <p className="muted">Turn on the test, then speak or play a video. The bars should move.</p>

                        <div className="fields">
                            <label className="check"><input type="checkbox" checked={settings.capture_mic} onChange={(e) => set("capture_mic", e.target.checked)} /> Microphone</label>
                            <label className="check"><input type="checkbox" checked={settings.capture_system} onChange={(e) => set("capture_system", e.target.checked)} /> System audio (the other side of a call)</label>
                        </div>

                        <LevelTest settings={settings} />
                    </>
                ) : null}

                {step === 4 ? (
                    <>
                        <Sparkles size={28} className="ok" />
                        <h2>You are ready</h2>
                        <p className="muted">
                            Press Start on the Live page. Models, the Python runtime and saved
                            conversations can be removed any time in Storage.
                        </p>
                    </>
                ) : null}

                <div className="onboard-nav">
                    <button className="btn" onClick={onFinish}>Skip</button>
                    <div className="spacer" />

                    {step > 0 ? (
                        <button className="btn" onClick={() => setStep(step - 1)}><ArrowLeft size={16} /><span>Back</span></button>
                    ) : null}

                    {step < STEPS.length - 1 ? (
                        <button className="btn primary" onClick={() => setStep(step + 1)}>
                            <span>Next</span><ArrowRight size={16} />
                        </button>
                    ) : (
                        <button className="btn primary" onClick={onFinish}><span>Finish</span></button>
                    )}
                </div>
            </div>
        </div>
    );
}
