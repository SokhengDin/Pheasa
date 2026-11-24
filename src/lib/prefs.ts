import { useCallback, useEffect, useState } from "react";

/**
 * Small settings kept in localStorage. The main window and the subtitle window
 * share one origin, so a change made in either shows up in the other through
 * the `storage` event.
 */
export function usePersisted<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
    const read = useCallback((): T => {
        try {
            const raw = localStorage.getItem(key);

            if (raw === null) return initial;

            const parsed = JSON.parse(raw);

            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                ? { ...initial, ...parsed }
                : parsed;
        } catch {
            return initial;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const [value, setValue] = useState<T>(read);

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === key) setValue(read());
        };

        window.addEventListener("storage", onStorage);

        return () => window.removeEventListener("storage", onStorage);
    }, [key, read]);

    const update = useCallback(
        (next: T | ((prev: T) => T)) => {
            setValue((prev) => {
                const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;

                try {
                    localStorage.setItem(key, JSON.stringify(resolved));
                } catch {
                    // Storage can be unavailable; the value still lives in memory.
                }

                return resolved;
            });
        },
        [key],
    );

    return [value, update];
}

export type FontFamily = "system" | "serif" | "rounded" | "mono";

export interface OverlayPrefs {
    opacity       : number;
    fontSize      : number;
    lines         : number;
    showOriginal  : boolean;
    showSpeaker   : boolean;
    locked        : boolean;
    fontFamily    : FontFamily;
    textColor     : string;
    outline       : boolean;
    bold          : boolean;
}

export const OVERLAY_DEFAULTS: OverlayPrefs = {
    opacity      : 0.78,
    fontSize     : 24,
    lines        : 2,
    showOriginal : true,
    showSpeaker  : true,
    locked       : false,
    fontFamily   : "system",
    textColor    : "#ffffff",
    outline      : false,
    bold         : false,
};

export const FONT_STACKS: Record<FontFamily, string> = {
    system  : "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif",
    serif   : "'New York', Georgia, 'Times New Roman', serif",
    rounded : "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, sans-serif",
    mono    : "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

export interface OverlayPreset {
    id    : string;
    label : string;
    hint  : string;
    prefs : Partial<OverlayPrefs>;
}

export const OVERLAY_PRESETS: OverlayPreset[] = [
    { id: "classic",  label: "Classic",  hint: "Dark glass box",             prefs: { opacity: 0.78, textColor: "#ffffff", outline: false, bold: false, fontFamily: "system"  } },
    { id: "cinema",   label: "Cinema",   hint: "Outlined text, no box",      prefs: { opacity: 0,    textColor: "#ffffff", outline: true,  bold: true,  fontFamily: "system"  } },
    { id: "contrast", label: "Contrast", hint: "Yellow on black",            prefs: { opacity: 0.92, textColor: "#ffe14d", outline: false, bold: true,  fontFamily: "system"  } },
    { id: "reader",   label: "Reader",   hint: "Serif, easy on the eyes",    prefs: { opacity: 0.85, textColor: "#f3ecdc", outline: false, bold: false, fontFamily: "serif"   } },
    { id: "friendly", label: "Friendly", hint: "Rounded and soft",           prefs: { opacity: 0.7,  textColor: "#ffffff", outline: false, bold: false, fontFamily: "rounded" } },
];

export const OVERLAY_KEY  = "lt.overlay.prefs";
export const GEOMETRY_KEY = "lt.overlay.geometry";
export const NAMES_KEY    = "lt.speaker.names";

const PALETTE = ["#4f8cff", "#3ecf8e", "#f5a524", "#e5609c", "#9b7bff", "#2ec4d6"];

/** The same speaker always gets the same colour, in both windows. */
export function speakerColor(name: string): string {
    let hash = 0;

    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;

    return PALETTE[hash % PALETTE.length];
}

export const IS_MAC = /Mac/i.test(navigator.userAgent);
