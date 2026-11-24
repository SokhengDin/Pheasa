import { useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

import { api, errorText } from "./api";
import type { RuntimeLog } from "./types";

/**
 * The Python runtime job (set up, add MLX, remove) outlives any one page: it
 * runs in the backend for minutes. Its progress lives here, at module level,
 * so leaving the Storage page and coming back shows the same job and log.
 */

export type RuntimeJobKind = "setup" | "mlx" | "remove";

export interface RuntimeJob {
    busy     : RuntimeJobKind | null;
    log      : string[];
    error    : string | null;
    /** When the running job started, in ms since the epoch. */
    started  : number | null;
    /** Counts finished jobs, so views know when to reload what is on disk. */
    finished : number;
}

export const JOB_LABEL: Record<RuntimeJobKind, string> = {
    setup  : "Setting up Python runtime",
    mlx    : "Adding Apple GPU (MLX)",
    remove : "Removing Python runtime",
};

const MAX_LINES = 400;

let state: RuntimeJob = { busy: null, log: [], error: null, started: null, finished: 0 };

const subscribers = new Set<() => void>();

function set(patch: Partial<RuntimeJob>) {
    state = { ...state, ...patch };
    subscribers.forEach((notify) => notify());
}

let listening = false;

/** Collects log lines from the backend for as long as the app runs. */
function ensureListening() {
    if (listening) return;

    listening = true;

    listen<RuntimeLog>("runtime-setup", (event) => {
        const { line, done, error } = event.payload;

        if (line) set({ log: [...state.log.slice(-MAX_LINES), line] });
        if (done && error) set({ error });
    }).catch(() => {
        listening = false;
    });
}

export async function runRuntimeJob(kind: RuntimeJobKind, flavor = "auto") {
    if (state.busy) return;

    ensureListening();

    set({ busy: kind, error: null, started: Date.now(), log: kind === "remove" ? state.log : [] });

    try {
        if (kind === "setup")  await api.setupRuntime(flavor);
        if (kind === "mlx")    await api.addMlxRuntime();
        if (kind === "remove") await api.removeRuntime();
    } catch (err) {
        set({ error: errorText(err) });
    } finally {
        set({ busy: null, started: null, finished: state.finished + 1 });
    }
}

export function clearRuntimeError() {
    if (state.error) set({ error: null });
}

function subscribe(notify: () => void) {
    subscribers.add(notify);

    return () => subscribers.delete(notify);
}

export function useRuntimeJob(): RuntimeJob {
    ensureListening();

    return useSyncExternalStore(subscribe, () => state);
}

/** Time elapsed since `started`, updated every second while it is set. */
export function useElapsed(started: number | null): string {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (started === null) return;

        setNow(Date.now());

        const timer = window.setInterval(() => setNow(Date.now()), 1000);

        return () => window.clearInterval(timer);
    }, [started]);

    return started === null ? "" : formatElapsed(now - started);
}

/** "2:07" style elapsed time. */
export function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
