import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api, errorText } from "../lib/api";
import type { AudioLevel, EngineStatus, Perf, TranscriptLine } from "../lib/types";

const MAX_LINES = 200;

interface TtsPayload {
    wav     : string;
    seconds : number;
}

/** Plays the spoken translations one after another. */
function useSpeechQueue() {
    const queue   = useRef<string[]>([]);
    const playing = useRef(false);

    const next = useCallback(() => {
        const wav = queue.current.shift();

        if (!wav) {
            playing.current = false;
            return;
        }

        playing.current = true;

        const audio   = new Audio(`data:audio/wav;base64,${wav}`);
        audio.onended = next;
        audio.onerror = next;

        audio.play().catch(next);
    }, []);

    return useCallback((wav: string) => {
        queue.current.push(wav);

        if (!playing.current) next();
    }, [next]);
}

/** `speech: false` for secondary windows, so a spoken translation plays only once. */
export function useEngine({ speech = true }: { speech?: boolean } = {}) {
    const [lines, setLines]   = useState<TranscriptLine[]>([]);
    const [status, setStatus] = useState<EngineStatus>({ state: "idle", message: "Stopped", device: "" });
    const [levels, setLevels] = useState<Record<string, number>>({ mic: 0, system: 0 });
    const [perf, setPerf]     = useState<Perf | null>(null);
    const alive               = useRef(true);
    const speak               = useSpeechQueue();

    useEffect(() => {
        alive.current = true;

        const unlisten = Promise.all([
            listen<TranscriptLine>("transcript", (event) => {
                const line = event.payload;

                setLines((prev) => {
                    const index = prev.findIndex((item) => item.id === line.id);

                    if (index === -1) {
                        return [...prev, line].slice(-MAX_LINES);
                    }

                    const next = prev.slice();
                    next[index] = { ...line, translation: line.translation ?? prev[index].translation };

                    return next;
                });
            }),
            // A line that turned out to be echo or noise after its live preview was shown.
            listen<number>("transcript-drop", (event) => {
                setLines((prev) => prev.filter((item) => item.id !== event.payload));
            }),
            listen<EngineStatus>("engine-status", (event) => setStatus(event.payload)),
            listen<AudioLevel>("audio-level", (event) => {
                const { source, peak } = event.payload;

                setLevels((prev) => ({ ...prev, [source]: peak }));
            }),
            listen<Perf>("engine-perf", (event) => setPerf(event.payload)),
            listen<TtsPayload>("tts-audio", (event) => {
                if (speech) speak(event.payload.wav);
            }),
        ]);

        api.engineRunning().then((running) => {
            if (alive.current && running) {
                setStatus({ state: "running", message: "Listening", device: "" });
            }
        });

        return () => {
            alive.current = false;
            unlisten.then((fns) => fns.forEach((fn) => fn()));
        };
    }, [speak, speech]);

    // Meters fall back to zero when no audio arrives (muted, stopped).
    useEffect(() => {
        const timer = window.setInterval(() => {
            setLevels((prev) => ({ mic: prev.mic * 0.8, system: prev.system * 0.8 }));
        }, 100);

        return () => window.clearInterval(timer);
    }, []);

    const start = useCallback(async () => {
        try {
            setPerf(null);
            await api.startEngine();
        } catch (err) {
            setStatus({ state: "error", message: errorText(err), device: "" });
        }
    }, []);

    const stop = useCallback(async () => {
        await api.stopEngine();
        setStatus({ state: "stopped", message: "Stopped", device: "" });
    }, []);

    const clear = useCallback(() => setLines([]), []);

    /** After a voice is saved: earlier lines of that unknown speaker now carry the person's name. */
    const relabel = useCallback((from: string, to: string) => {
        setLines((prev) => prev.map((line) => (line.speaker === from ? { ...line, speaker: to, known: true } : line)));
    }, []);

    return { lines, status, levels, perf, start, stop, clear, relabel };
}
