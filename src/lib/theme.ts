import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { usePersisted } from "./prefs";

/**
 * Appearance: follow the system, or force light or dark.
 *
 * The page reads `data-theme` on <html> (absent means "follow the system").
 * The native window gets the same theme, so the macOS glass material behind the
 * transparent window and the traffic lights match the page.
 */

export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "lt.theme";

export const THEMES: { id: Theme; label: string }[] = [
    { id: "system", label: "System" },
    { id: "light",  label: "Light" },
    { id: "dark",   label: "Dark" },
];

function isTheme(value: unknown): value is Theme {
    return value === "system" || value === "light" || value === "dark";
}

/** The saved theme, read synchronously so the first paint already has it. */
export function savedTheme(): Theme {
    try {
        const raw = localStorage.getItem(THEME_KEY);
        const parsed: unknown = raw === null ? null : JSON.parse(raw);

        return isTheme(parsed) ? parsed : "system";
    } catch {
        return "system";
    }
}

/** Sets the page theme, and the native window theme for the main window. */
export function applyTheme(theme: Theme) {
    const root = document.documentElement;

    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;

    // The subtitle window is always dark and keeps its own native look.
    if (window.location.hash === "#overlay") return;

    try {
        getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => undefined);
    } catch {
        // Not running inside Tauri (browser during development).
    }
}

export function useTheme(): [Theme, (theme: Theme) => void] {
    const [stored, setTheme] = usePersisted<Theme>(THEME_KEY, "system");
    const theme              = isTheme(stored) ? stored : "system";

    useEffect(() => applyTheme(theme), [theme]);

    return [theme, setTheme];
}
