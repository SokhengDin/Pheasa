import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { CompactView } from "./components/CompactView";
import { HistoryView } from "./components/HistoryView";
import { LiveView } from "./components/LiveView";
import { ModelsView } from "./components/ModelsView";
import { Onboarding } from "./components/Onboarding";
import { OverlayView } from "./components/OverlayView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar, type View } from "./components/Sidebar";
import { StorageView } from "./components/StorageView";
import { useEngine } from "./hooks/useEngine";
import { api, errorText } from "./lib/api";
import { NAMES_KEY, OVERLAY_DEFAULTS, OVERLAY_KEY, usePersisted } from "./lib/prefs";
import { languageName } from "./lib/types";
import type { Settings } from "./lib/types";

const ONBOARDED_KEY = "lt.onboarded";

/** In development, `?view=models` opens that page, so a browser can go straight to it. */
function devView(): View {
    if (!import.meta.env.DEV) return "live";

    const wanted = new URLSearchParams(window.location.search).get("view");

    return (wanted as View | null) ?? "live";
}

function wasOnboarded(): boolean {
    try {
        return localStorage.getItem(ONBOARDED_KEY) === "1";
    } catch {
        return true;
    }
}

function Shell() {
    const [view, setView]             = useState<View>(devView);
    const [settings, setSettings]     = useState<Settings | null>(null);
    const engine                      = useEngine();
    const [names, setNames]           = usePersisted<Record<string, string>>(NAMES_KEY, {});
    const [prefs, setPrefs]           = usePersisted(OVERLAY_KEY, OVERLAY_DEFAULTS);
    const [overlay, setOverlay]       = useState(false);
    const [compact, setCompact]       = useState(false);
    const [onboarding, setOnboarding] = useState(!wasOnboarded());
    const [notice, setNotice]         = useState<string | null>(null);
    const saveTimer                   = useRef<number | undefined>(undefined);
    const savedFinals                 = useRef(0);
    const previousSize                = useRef<{ w: number; h: number } | null>(null);

    useEffect(() => {
        api.getSettings().then(setSettings);
    }, []);

    useEffect(() => {
        api.setOverlay(overlay).catch(() => undefined);
    }, [overlay]);

    const flash = useCallback((text: string) => {
        setNotice(text);
        window.setTimeout(() => setNotice(null), 2600);
    }, []);

    const update = useCallback((next: Settings) => {
        setSettings(next);

        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => api.saveSettings(next).catch(() => undefined), 300);
    }, []);

    const running = engine.status.state === "running";
    const busy    = engine.status.state === "loading";

    const startNow = useCallback(() => {
        if (!settings) return;

        // Persist immediately: the engine reads saved settings.
        window.clearTimeout(saveTimer.current);
        api.saveSettings(settings).then(engine.start);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings, engine.start]);

    const saveConversation = useCallback(async (quiet = false) => {
        if (!settings) return;

        const finals = engine.lines.filter((l) => l.is_final && l.text);

        if (finals.length === 0 || finals.length === savedFinals.current) return;

        const title = `${languageName(settings.source_lang)} to ${languageName(settings.target_lang)}, ${new Date().toLocaleString()}`;

        try {
            await api.saveSession(title, settings.source_lang, settings.target_lang, finals);
            savedFinals.current = finals.length;

            if (!quiet) flash("Saved to History");
        } catch (err) {
            flash(errorText(err));
        }
    }, [settings, engine.lines, flash]);

    // Save the conversation when the translator stops.
    const wasRunning = useRef(false);

    useEffect(() => {
        if (wasRunning.current && !running && !busy) saveConversation(true);

        wasRunning.current = running;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [running, busy]);

    const clearLines = () => {
        savedFinals.current = 0;
        engine.clear();
    };

    // Compact mode: a small window that stays on top of everything.
    const enterCompact = async () => {
        const win   = getCurrentWindow();
        const size  = await win.innerSize();
        const scale = await win.scaleFactor();

        previousSize.current = { w: size.width / scale, h: size.height / scale };

        await win.setMinSize(new LogicalSize(300, 100));
        await win.setSize(new LogicalSize(400, 150));
        await win.setAlwaysOnTop(true);

        setCompact(true);
    };

    const exitCompact = async () => {
        const win  = getCurrentWindow();
        const back = previousSize.current ?? { w: 1120, h: 740 };

        await win.setAlwaysOnTop(false);
        await win.setMinSize(new LogicalSize(900, 560));
        await win.setSize(new LogicalSize(back.w, back.h));

        setCompact(false);
    };

    // Global shortcuts and tray menu both arrive as "shortcut" events.
    const handlers = useRef<Record<string, () => void>>({});

    handlers.current = {
        toggle    : () => (running ? engine.stop() : !busy && settings?.stt_model ? startNow() : undefined),
        subtitles : () => setOverlay((v) => !v),
        lock      : () => setPrefs({ ...prefs, locked: !prefs.locked }),
    };

    useEffect(() => {
        const unlisten = listen<string>("shortcut", (event) => handlers.current[event.payload]?.());

        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    // Keyboard: Cmd/Ctrl+1..5 switch pages, Cmd/Ctrl+Enter starts or stops.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey)) return;

            const pages: Record<string, View> = { "1": "live", "2": "history", "3": "models", "4": "storage", "5": "settings" };

            if (pages[event.key]) {
                event.preventDefault();
                setView(pages[event.key]);
            } else if (event.key === "Enter" && settings?.stt_model && !busy) {
                event.preventDefault();
                running ? engine.stop() : startNow();
            }
        };

        window.addEventListener("keydown", onKey);

        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    const rename = (speaker: string, name: string) =>
        setNames((prev) => {
            const { [speaker]: _old, ...rest } = prev;

            return name ? { ...rest, [speaker]: name } : rest;
        });

    /** Saves the voice behind an unknown speaker, so that person is recognised by name from now on. */
    const remember = async (speaker: string, name: string) => {
        try {
            const saved = await api.rememberVoice(speaker, name);

            engine.relabel(speaker, saved);
            flash(`Saved the voice of ${saved}. It will be recognised in future meetings`);
        } catch (err) {
            flash(errorText(err));
        }
    };

    const finishOnboarding = () => {
        try {
            localStorage.setItem(ONBOARDED_KEY, "1");
        } catch {
            // The wizard may show again next launch; that is harmless.
        }

        if (settings) api.saveSettings(settings).catch(() => undefined);

        setOnboarding(false);
    };

    if (!settings) return <div className="empty">Loading</div>;

    if (compact) {
        return (
            <CompactView
                settings={settings}
                status={engine.status}
                lines={engine.lines}
                levels={engine.levels}
                names={names}
                onStart={startNow}
                onStop={engine.stop}
                onExpand={exitCompact}
            />
        );
    }

    return (
        <div className="shell">
            <Sidebar view={view} device={running ? engine.status.device : ""} onChange={setView} />

            <main className="content">
                {view === "live" && (
                    <LiveView
                        settings={settings}
                        status={engine.status}
                        lines={engine.lines}
                        levels={engine.levels}
                        perf={engine.perf}
                        names={names}
                        onRename={rename}
                        onRemember={remember}
                        onChange={update}
                        onStart={startNow}
                        onStop={engine.stop}
                        onClear={clearLines}
                        onSave={() => saveConversation(false)}
                        onCompact={enterCompact}
                        overlay={overlay}
                        onOverlay={setOverlay}
                        onOpen={(target) => setView(target)}
                    />
                )}

                {view === "history"  && <HistoryView names={names} onRename={rename} />}
                {view === "models"   && <ModelsView settings={settings} onChange={update} onOpen={setView} />}
                {view === "storage"  && <StorageView settings={settings} onChange={setSettings} />}
                {view === "settings" && <SettingsView settings={settings} onChange={update} />}
            </main>

            {notice ? <div className="toast">{notice}</div> : null}

            {onboarding ? <Onboarding settings={settings} onChange={update} onFinish={finishOnboarding} /> : null}
        </div>
    );
}

export default function App() {
    return window.location.hash === "#overlay" ? <OverlayView /> : <Shell />;
}
