import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowRightLeft, Ear, Languages, Lock, LockOpen, Minimize2, Monitor, Moon, PictureInPicture2, Play, Save, Square, Sun, Trash2 } from "lucide-react";

import { CommandPalette, type Command } from "./components/CommandPalette";
import { CompactView } from "./components/CompactView";
import { HistoryView } from "./components/HistoryView";
import { LiveView } from "./components/LiveView";
import { ModelsView } from "./components/ModelsView";
import { Onboarding } from "./components/Onboarding";
import { OverlayView } from "./components/OverlayView";
import { SettingsView } from "./components/SettingsView";
import { MOD, PAGES, Sidebar, type View } from "./components/Sidebar";
import { StorageView } from "./components/StorageView";
import { GLASS_STRONG, cx } from "./components/ui";
import { useEngine } from "./hooks/useEngine";
import { api, errorText } from "./lib/api";
import { NAMES_KEY, OVERLAY_DEFAULTS, OVERLAY_KEY, usePersisted } from "./lib/prefs";
import { THEMES, useTheme } from "./lib/theme";
import { AUTO_LANGUAGE, LANGUAGES, languageName } from "./lib/types";
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
    const [palette, setPalette]       = useState(false);
    const [theme, setTheme]           = useTheme();
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
        await win.setMinSize(new LogicalSize(720, 500));
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

    // Keyboard: Cmd/Ctrl+K opens the command palette, Cmd/Ctrl+Enter starts or stops.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey)) return;

            if (event.key.toLowerCase() === "k") {
                event.preventDefault();
                setPalette((open) => !open);
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

    if (!settings) return <div className="flex h-full items-center justify-center text-muted">Loading</div>;

    const hasLines = engine.lines.length > 0;
    const auto     = settings.source_lang === AUTO_LANGUAGE.code;

    const commands: Command[] = [
        running
            ? { id: "stop",  group: "Translator", label: "Stop translating",  icon: Square, hint: `${MOD}↩`, keywords: "end pause", run: engine.stop }
            : { id: "start", group: "Translator", label: "Start translating", icon: Play,   hint: `${MOD}↩`, keywords: "begin listen record", disabled: busy || !settings.stt_model, run: startNow },
        { id: "subtitles", group: "Translator", label: overlay ? "Hide subtitle window" : "Show subtitle window", icon: PictureInPicture2, keywords: "overlay captions floating", run: () => setOverlay((v) => !v) },
        { id: "lock",      group: "Translator", label: prefs.locked ? "Unlock subtitles" : "Lock subtitles", icon: prefs.locked ? LockOpen : Lock, keywords: "click through mouse", disabled: !overlay, run: () => setPrefs({ ...prefs, locked: !prefs.locked }) },
        { id: "swap",      group: "Translator", label: "Swap languages", icon: ArrowRightLeft, keywords: "reverse switch", disabled: running || busy || auto, run: () => update({ ...settings, source_lang: settings.target_lang, target_lang: settings.source_lang }) },
        { id: "save",      group: "Translator", label: "Save conversation to History", icon: Save, disabled: !hasLines, run: () => saveConversation(false) },
        { id: "clear",     group: "Translator", label: "Clear transcript", icon: Trash2, keywords: "erase reset", disabled: !hasLines, run: clearLines },
        { id: "compact",   group: "Translator", label: "Compact window", icon: Minimize2, keywords: "small mini always on top", run: enterCompact },

        ...THEMES.map((option) => ({
            id       : `theme-${option.id}`,
            group    : "Appearance",
            label    : option.id === "system" ? "Match system appearance" : `${option.label} appearance`,
            icon     : option.id === "dark" ? Moon : option.id === "light" ? Sun : Monitor,
            keywords : "theme mode dark light colour color",
            disabled : theme === option.id,
            run      : () => setTheme(option.id),
        })),

        ...PAGES.map((page) => ({
            id    : `go-${page.id}`,
            group : "Go to",
            label : page.label,
            icon  : page.icon,
            keywords: "page open view",
            run   : () => setView(page.id),
        })),

        ...LANGUAGES.map((lang) => ({
            id        : `to-${lang.code}`,
            group     : "Translate into",
            label     : `Translate into ${lang.name}`,
            icon      : Languages,
            keywords  : "target",
            searchOnly: true,
            disabled  : running || busy || settings.target_lang === lang.code,
            run       : () => update({ ...settings, target_lang: lang.code }),
        })),

        ...[AUTO_LANGUAGE, ...LANGUAGES].map((lang) => ({
            id        : `from-${lang.code}`,
            group     : "Listen for",
            label     : `Listen for ${lang.name}`,
            icon      : Ear,
            keywords  : "source spoken",
            searchOnly: true,
            disabled  : running || busy || settings.source_lang === lang.code,
            run       : () => update({ ...settings, source_lang: lang.code }),
        })),
    ];

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
        // On macOS the window is transparent: a translucent background lets the
        // native material tint the whole app. The wash gives the glass colour to pick up.
        <div className="relative isolate flex h-full bg-bg wash mac:bg-bg/72">
            <Sidebar view={view} device={running ? engine.status.device : ""} onChange={setView} onCommand={() => setPalette(true)} />

            {/* An inline-size container: pages centre their content with px-gutter. */}
            <main className="flex min-w-0 flex-1 @container">

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
                {view === "settings" && <SettingsView settings={settings} onChange={update} theme={theme} onTheme={setTheme} />}
            </main>

            {notice ? (
                <div className="fixed inset-x-0 bottom-6 z-[60] flex justify-center pointer-events-none">
                    <div className={cx("relative rounded-full px-5 py-[11px] font-medium rim animate-toast", GLASS_STRONG)}>{notice}</div>
                </div>
            ) : null}

            <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} />

            {onboarding ? <Onboarding settings={settings} onChange={update} onFinish={finishOnboarding} /> : null}
        </div>
    );
}

export default function App() {
    return window.location.hash === "#overlay" ? <OverlayView /> : <Shell />;
}
