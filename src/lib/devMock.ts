// Browser-only stand-in for the Tauri backend, so the interface can be opened
// and checked with `bun run dev` in a plain browser (no Rust build needed).
// It is loaded only in development, and only when Tauri is not present.

import type { ModelCard, Recommendation, RuntimeStatus, Session, SessionInfo, Settings, TranscriptLine, VoiceInfo } from "./types";

const MB = 1_000_000;

const SETTINGS: Settings = {
    source_lang              : new URLSearchParams(location.search).has("mismatch") ? "km" : "fr",
    target_lang              : "en",
    device                   : "auto",
    stt_model                : new URLSearchParams(location.search).has("installed") ? "mlx-community/whisper-large-v3-turbo" : null,
    mt_backend               : "local",
    mt_model                 : new URLSearchParams(location.search).has("mismatch") ? "Helsinki-NLP/opus-mt-fr-en" : null,
    cloud                    : { base_url: "https://api.openai.com/v1", api_key: "", model: "" },
    capture_mic              : true,
    capture_system           : true,
    mic_device               : null,
    system_device            : null,
    separate_remote_speakers : true,
    speaker_threshold        : 0.45,
    neural_vad               : true,
    echo_guard               : true,
    speaker_model            : null,
    mt_model_2               : null,
    tts_model                : null,
    speak_translation        : false,
    glossary                 : [],
} as Settings;

const RUNTIME: RuntimeStatus = {
    python_version : "3.13.5",
    ready          : true,
    flavor         : "auto",
    mlx            : false,
    mlx_supported  : true,
    size_bytes     : 2_300 * MB,
    removal_queued : false,
};

const card = (
    id: string, backend: ModelCard["backend"], downloads: number, size: number, note: string, tags: string[],
    compatible = true,
): ModelCard => ({
    id, task: "stt", backend, downloads, likes: Math.round(downloads / 900), tags, compatible, note,
    installed: false, size_bytes: size * MB, recommended: false,
});

const MLX_CARDS: ModelCard[] = [
    card("mlx-community/parakeet-tdt-0.6b-v3",   "mlx", 2_686_555, 2509, "Runs on the Apple GPU with MLX", ["mlx", "parakeet"]),
    card("mlx-community/whisper-large-v3-turbo", "mlx",   401_235, 1614, "Runs on the Apple GPU with MLX", ["mlx", "whisper"]),
    card("mlx-community/whisper-small-mlx",      "mlx",   289_837,  481, "Runs on the Apple GPU with MLX", ["mlx", "whisper"]),
    card("PollardWeights/Qwen3-ASR-1.7B-Pollard", "mlx",    4_657, 3100, "No MLX weights in this repository", ["gguf", "mlx"], false),
];

const ALL_CARDS: ModelCard[] = [
    card("openai/whisper-base",        "native", 6_353_852,  290, "Runs in the built-in engine", ["whisper"]),
    card("openai/whisper-small",       "native", 4_224_568,  967, "Runs in the built-in engine", ["whisper"]),
    card("Systran/faster-whisper-small", "native", 6_834_738, 480, "Not a Transformers or MLX model, so no engine here can run it", ["ctranslate2"], false),
    ...MLX_CARDS.slice(0, 2),
];

const MT_RECS: Recommendation[] = [
    { id: "mlx-community/Hy-MT2-1.8B-4bit",         task: "translation", backend: "mlx",    size_bytes: 1017 * MB, note: "Translation model on the Apple GPU, many languages", installed: false },
    { id: "facebook/nllb-200-distilled-600M",       task: "translation", backend: "python", size_bytes: 2450 * MB, note: "200 languages in one model",                          installed: false },
];

const RECS: Recommendation[] = [
    { id: "mlx-community/whisper-large-v3-turbo", task: "stt", backend: "mlx",    size_bytes: 1614 * MB, note: "Best accuracy, fast on the Apple GPU", installed: false },
    { id: "openai/whisper-base",                  task: "stt", backend: "native", size_bytes:  290 * MB, note: "Good balance on most laptops",         installed: false },
];

// `?demo` fills the app with a conversation, models and saved sessions.
const line = (id: number, speaker: string, source: "mic" | "system", text: string, translation: string | null, final = true): TranscriptLine => ({
    id, source, speaker, is_final: final, text, translation, known: source === "mic" || speaker === "Dara", started_ms: id * 4000, ended_ms: id * 4000 + 3200,
});

const DEMO_LINES: TranscriptLine[] = [
    line(1, "Dara", "system", "Bonjour à tous, merci de vous être joints à cet appel.", "Hello everyone, thank you for joining this call."),
    line(2, "Dara", "system", "On commence par le point sur le stage chez GI2.", "Let's start with the update on the internship at GI2."),
    line(3, "You",      "mic",    "Très bien, j'ai préparé quelques diapositives.", "Very good, I have prepared a few slides."),
    line(4, "Speaker B", "system", "Parfait. Est-ce que vous pouvez partager votre écran ?", "Perfect. Can you share your screen?"),
    line(5, "You",      "mic",    "Oui, un instant, je le partage maintenant.", "Yes, one moment, I am sharing it now."),
    line(6, "Speaker B", "system", "Et pour le budget, nous devons encore décider", null, false),
];

const DEMO_SESSIONS: SessionInfo[] = [
    { id: Date.now() - 3_600_000, title: "Weekly sync with GI2",  source_lang: "fr", target_lang: "en", count: 42, preview: "Bonjour à tous, merci de vous être joints", size_bytes: 9_400,  matches: 0 },
    { id: Date.now() - 86_400_000 * 2, title: "IFPEN onboarding call", source_lang: "fr", target_lang: "en", count: 118, preview: "Bienvenue chez IFP Energies nouvelles",   size_bytes: 24_100, matches: 0 },
    { id: Date.now() - 86_400_000 * 9, title: "Lecture, optimisation", source_lang: "fr", target_lang: "en", count: 76, preview: "Aujourd'hui nous parlons de dualité",     size_bytes: 15_800, matches: 0 },
];

const DEMO = new URLSearchParams(window.location.search).has("demo");

let VOICES: VoiceInfo[] = DEMO
    ? [
        { id: "v1", name: "Dara",   samples: 4, created: Date.now() - 86_400_000 * 3 },
        { id: "v2", name: "Sophea", samples: 2, created: Date.now() - 86_400_000 },
    ]
    : [];

async function answer(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    switch (cmd) {
        case "get_settings":          return SETTINGS;
        case "list_compute_devices":  return [
            { id: "cpu",   label: "CPU",               available: true,  note: "Works on every platform" },
            { id: "mlx",   label: "Apple GPU (MLX)",   available: true,  note: "MLX models run on the Apple GPU. Install MLX in Storage" },
            { id: "metal", label: "Apple GPU (Metal)", available: true,  note: "Metal device found" },
        ];
        case "list_audio_devices":    return [];
        case "engine_running":        return false;
        case "runtime_status":        return RUNTIME;
        case "list_installed":        if (args.task === "translation") return new URLSearchParams(location.search).has("mismatch")
            ? [{ id: "Helsinki-NLP/opus-mt-fr-en", task: "translation", backend: "native", size_bytes: 300 * MB, src_lang: "fr", tgt_lang: "en" }]
            : [];
            return new URLSearchParams(location.search).has("installed")
            ? [{ id: "mlx-community/whisper-large-v3-turbo", task: "stt", backend: "mlx", size_bytes: 1614 * MB, src_lang: null, tgt_lang: null }]
            : [];
        case "recommended_models":    return args.task === "translation" ? MT_RECS : RECS;
        case "list_voices":           return VOICES;
        case "delete_voice": {
            VOICES = VOICES.filter((v) => v.id !== args.id);

            return null;
        }
        case "rename_voice": {
            VOICES = VOICES.map((v) => (v.id === args.id ? { ...v, name: String(args.name) } : v));

            return null;
        }
        case "enroll_voice": {
            await new Promise((resolve) => window.setTimeout(resolve, 1200));

            const voice = { id: `v${Date.now()}`, name: String(args.name), samples: 3, created: Date.now() };
            VOICES = [...VOICES, voice];

            return voice;
        }
        case "remember_voice": return String(args.name);
        case "list_sessions":         return DEMO ? DEMO_SESSIONS : [];
        case "load_session":          return { ...DEMO_SESSIONS[0], entries: DEMO_LINES.map((l) => ({ ...l, is_final: true, translation: l.translation ?? "..." })) } satisfies Session;
        case "search_models": {
            const tag = String(args.tag ?? "");

            if (tag === "mlx") return MLX_CARDS;
            if (tag === "")    return ALL_CARDS;

            return [];
        }
        case "storage_report": return {
            models: [], models_bytes: 0, runtime: RUNTIME, sessions_bytes: 0, total_bytes: RUNTIME.size_bytes,
            path: "/Users/you/Library/Application Support/live-translator",
        };
        default: return null;
    }
}

export function installDevMock() {
    const w = window as unknown as Record<string, unknown>;

    if ("__TAURI_INTERNALS__" in w) return;

    // Skip the first-run wizard unless the address asks for it with ?onboarding.
    try {
        if (!new URLSearchParams(window.location.search).has("onboarding")) {
            localStorage.setItem("lt.onboarded", "1");
        }
    } catch {
        // Storage can be unavailable; the wizard then simply shows.
    }

    let ids = 0;

    const callbacks = new Map<number, (payload: unknown) => void>();
    const listeners = new Map<string, number[]>();

    const emit = (event: string, payload: unknown) => {
        for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
    };

    if (DEMO) {
        SETTINGS.stt_model = "openai/whisper-base";
        SETTINGS.mt_model  = "Helsinki-NLP/opus-mt-fr-en";

        // Replay the conversation a little after the page opens.
        window.setTimeout(() => {
            emit("engine-status", { state: "running", message: "Listening", device: "Apple GPU (MLX)" });
            emit("engine-perf", { rtf: 0.31, stt_ms: 420, mt_ms: 90, audio_ms: 3200 });

            if (new URLSearchParams(window.location.search).get("demo") !== "empty") {
                DEMO_LINES.forEach((entry) => emit("transcript", entry));
            }
        }, 300);

        window.setInterval(() => {
            emit("audio-level", { source: "mic",    peak: 0.15 + Math.random() * 0.5 });
            emit("audio-level", { source: "system", peak: 0.1  + Math.random() * 0.6 });
        }, 120);
    }

    w.__TAURI_INTERNALS__ = {
        metadata: {
            currentWindow  : { label: "main" },
            currentWebview : { windowLabel: "main", label: "main" },
        },
        transformCallback: (callback: (payload: unknown) => void) => {
            const id = ++ids;
            callbacks.set(id, callback);

            return id;
        },
        unregisterCallback: () => undefined,
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
            if (cmd === "plugin:event|listen") {
                const event   = String(args?.event);
                const handler = Number(args?.handler);

                listeners.set(event, [...(listeners.get(event) ?? []), handler]);

                return handler;
            }

            return answer(cmd, args);
        },
    };

    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
}
