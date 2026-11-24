export type DevicePref = "auto" | "cpu" | "cuda" | "metal";
export type MtBackend  = "local" | "cloud";
export type Task       = "stt" | "translation" | "tts" | "speaker";
export type Backend    = "native" | "python" | "mlx";

export interface CloudConfig {
    base_url : string;
    api_key  : string;
    model    : string;
}

export interface GlossaryEntry {
    from : string;
    to   : string;
}

export interface Settings {
    source_lang              : string;
    target_lang              : string;
    device                   : DevicePref;
    stt_model                : string | null;
    mt_backend               : MtBackend;
    mt_model                 : string | null;
    cloud                    : CloudConfig;
    capture_mic              : boolean;
    capture_system           : boolean;
    mic_device               : string | null;
    system_device            : string | null;
    separate_remote_speakers : boolean;
    speaker_threshold        : number;
    neural_vad               : boolean;
    echo_guard               : boolean;
    speaker_model            : string | null;
    mt_model_2               : string | null;
    tts_model                : string | null;
    speak_translation        : boolean;
    glossary                 : GlossaryEntry[];
}

export interface ComputeDevice {
    id        : string;
    label     : string;
    available : boolean;
    note      : string;
}

export interface AudioDeviceInfo {
    key            : string;
    name           : string;
    host           : string;
    input          : boolean;
    output         : boolean;
    default_input  : boolean;
    default_output : boolean;
}

export interface ModelCard {
    id          : string;
    task        : Task;
    backend     : Backend;
    downloads   : number;
    likes       : number;
    tags        : string[];
    compatible  : boolean;
    note        : string;
    installed   : boolean;
    size_bytes  : number;
    recommended : boolean;
}

export interface Recommendation {
    id         : string;
    task       : Task;
    backend    : Backend;
    size_bytes : number;
    note       : string;
    installed  : boolean;
}

export interface ModelMeta {
    id         : string;
    task       : Task;
    backend    : Backend;
    src_lang   : string | null;
    tgt_lang   : string | null;
    size_bytes : number;
}

export interface DownloadProgress {
    id         : string;
    downloaded : number;
    total      : number;
    done       : boolean;
}

export interface TranscriptLine {
    id          : number;
    source      : "mic" | "system";
    speaker     : string;
    is_final    : boolean;
    text        : string;
    translation : string | null;
    /** True for "You" and for people with a saved voice; false for a voice nobody has named yet. */
    known?      : boolean;
    started_ms  : number;
    ended_ms    : number;
}

/** A person the app recognises by voice. */
export interface VoiceInfo {
    id      : string;
    name    : string;
    samples : number;
    created : number;
}

export interface RuntimeStatus {
    python_version : string | null;
    ready          : boolean;
    flavor         : string | null;
    mlx            : boolean;
    mlx_supported  : boolean;
    size_bytes     : number;
    removal_queued : boolean;
}

export interface RuntimeLog {
    line  : string | null;
    done  : boolean;
    error : string | null;
}

export interface StorageReport {
    models         : ModelMeta[];
    models_bytes   : number;
    runtime        : RuntimeStatus;
    sessions_bytes : number;
    total_bytes    : number;
    path           : string;
}

export interface SessionInfo {
    id          : number;
    title       : string;
    source_lang : string;
    target_lang : string;
    count       : number;
    preview     : string;
    size_bytes  : number;
    matches     : number;
}

export interface Session {
    id          : number;
    title       : string;
    source_lang : string;
    target_lang : string;
    entries     : TranscriptLine[];
}

export interface AudioLevel {
    source : "mic" | "system";
    rms    : number;
    peak   : number;
}

export interface Perf {
    rtf      : number;
    stt_ms   : number;
    mt_ms    : number;
    audio_ms : number;
}

export interface EngineStatus {
    state   : "idle" | "loading" | "running" | "stopped" | "error";
    message : string;
    device  : string;
}

/** Every language Whisper can transcribe. Keep in sync with LANGUAGES in translate/mod.rs. */
const WHISPER_LANGUAGES = [
    "af Afrikaans", "am Amharic", "ar Arabic", "as Assamese", "az Azerbaijani", "ba Bashkir",
    "be Belarusian", "bg Bulgarian", "bn Bengali", "bo Tibetan", "br Breton", "bs Bosnian",
    "ca Catalan", "cs Czech", "cy Welsh", "da Danish", "de German", "el Greek", "en English",
    "es Spanish", "et Estonian", "eu Basque", "fa Persian", "fi Finnish", "fo Faroese",
    "fr French", "gl Galician", "gu Gujarati", "ha Hausa", "haw Hawaiian", "he Hebrew",
    "hi Hindi", "hr Croatian", "ht Haitian Creole", "hu Hungarian", "hy Armenian",
    "id Indonesian", "is Icelandic", "it Italian", "ja Japanese", "jw Javanese", "ka Georgian",
    "kk Kazakh", "km Khmer", "kn Kannada", "ko Korean", "la Latin", "lb Luxembourgish",
    "ln Lingala", "lo Lao", "lt Lithuanian", "lv Latvian", "mg Malagasy", "mi Maori",
    "mk Macedonian", "ml Malayalam", "mn Mongolian", "mr Marathi", "ms Malay", "mt Maltese",
    "my Myanmar", "ne Nepali", "nl Dutch", "nn Nynorsk", "no Norwegian", "oc Occitan",
    "pa Punjabi", "pl Polish", "ps Pashto", "pt Portuguese", "ro Romanian", "ru Russian",
    "sa Sanskrit", "sd Sindhi", "si Sinhala", "sk Slovak", "sl Slovenian", "sn Shona",
    "so Somali", "sq Albanian", "sr Serbian", "su Sundanese", "sv Swedish", "sw Swahili",
    "ta Tamil", "te Telugu", "tg Tajik", "th Thai", "tk Turkmen", "tl Tagalog", "tr Turkish",
    "tt Tatar", "uk Ukrainian", "ur Urdu", "uz Uzbek", "vi Vietnamese", "yi Yiddish",
    "yo Yoruba", "yue Cantonese", "zh Chinese",
];

export const LANGUAGES: { code: string; name: string }[] = WHISPER_LANGUAGES
    .map((entry) => {
        const space = entry.indexOf(" ");

        return { code: entry.slice(0, space), name: entry.slice(space + 1) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

export const AUTO_LANGUAGE = { code: "auto", name: "Detect automatically" };

export function languageName(code: string): string {
    return code === "auto"
        ? AUTO_LANGUAGE.name
        : LANGUAGES.find((l) => l.code === code)?.name ?? code;
}
