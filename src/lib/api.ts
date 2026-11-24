import { invoke } from "@tauri-apps/api/core";

import type {
    AudioDeviceInfo,
    Backend,
    ComputeDevice,
    ModelCard,
    ModelMeta,
    Recommendation,
    RuntimeStatus,
    Session,
    SessionInfo,
    Settings,
    StorageReport,
    Task,
    TranscriptLine,
    VoiceInfo,
} from "./types";

export const api = {
    getSettings       : ()                              => invoke<Settings>("get_settings"),
    saveSettings      : (settings: Settings)            => invoke<void>("save_settings", { settings }),
    computeDevices    : ()                              => invoke<ComputeDevice[]>("list_compute_devices"),
    audioDevices      : ()                              => invoke<AudioDeviceInfo[]>("list_audio_devices"),
    startEngine       : ()                              => invoke<void>("start_engine"),
    stopEngine        : ()                              => invoke<void>("stop_engine"),
    engineRunning     : ()                              => invoke<boolean>("engine_running"),
    searchModels      : (task: Task, query: string, tag = "") =>
        invoke<ModelCard[]>("search_models", { task, query, tag }),
    startMonitor      : ()                              => invoke<void>("start_monitor"),
    listVoices        : ()                              => invoke<VoiceInfo[]>("list_voices"),
    deleteVoice       : (id: string)                    => invoke<void>("delete_voice", { id }),
    renameVoice       : (id: string, name: string)      => invoke<void>("rename_voice", { id, name }),
    enrollVoice       : (name: string, seconds: number) => invoke<VoiceInfo>("enroll_voice", { name, seconds }),
    rememberVoice     : (label: string, name: string)   => invoke<string>("remember_voice", { label, name }),
    stopMonitor       : ()                              => invoke<void>("stop_monitor"),
    recommended       : (task: Task, src: string, tgt: string) =>
        invoke<Recommendation[]>("recommended_models", { task, src, tgt }),
    downloadModel     : (id: string, task: Task, backend: Backend) =>
        invoke<void>("download_model", { id, task, backend }),
    cancelDownload    : (id: string)                    => invoke<void>("cancel_download", { id }),
    listInstalled     : (task: Task | null = null)      => invoke<ModelMeta[]>("list_installed", { task }),
    deleteModel       : (id: string, task: Task)        => invoke<Settings>("delete_model", { id, task }),
    runtimeStatus     : ()                              => invoke<RuntimeStatus>("runtime_status"),
    setupRuntime      : (flavor: string)                => invoke<RuntimeStatus>("setup_runtime", { flavor }),
    addMlxRuntime     : ()                              => invoke<RuntimeStatus>("add_mlx_runtime"),
    removeRuntime     : ()                              => invoke<RuntimeStatus>("remove_runtime"),
    storageReport     : ()                              => invoke<StorageReport>("storage_report"),
    revealDataDir     : ()                              => invoke<void>("reveal_data_dir"),
    saveSession       : (title: string, sourceLang: string, targetLang: string, entries: TranscriptLine[]) =>
        invoke<number>("save_session", { title, sourceLang, targetLang, entries }),
    listSessions      : (query: string)                 => invoke<SessionInfo[]>("list_sessions", { query }),
    loadSession       : (id: number)                    => invoke<Session>("load_session", { id }),
    deleteSession     : (id: number)                    => invoke<void>("delete_session", { id }),
    clearSessions     : ()                              => invoke<void>("clear_sessions"),
    setOverlay        : (visible: boolean)              => invoke<void>("set_overlay", { visible }),
    saveTextFile      : (suggestedName: string, extension: string, content: string) =>
        invoke<string | null>("save_text_file", { suggestedName, extension, content }),
};

export function errorText(err: unknown): string {
    return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

export function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B";

    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));

    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** "03:07", or "1:02:09" past an hour: the time since the translator started. */
export function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h     = Math.floor(total / 3600);
    const m     = Math.floor((total % 3600) / 60);
    const s     = total % 60;
    const two   = (n: number) => String(n).padStart(2, "0");

    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

export function formatCount(value: number): string {
    return value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : value >= 1_000
            ? `${(value / 1_000).toFixed(1)}K`
            : String(value);
}
