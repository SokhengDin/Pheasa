//! Local model store. Every downloaded model lives in
//! `<app data>/models/<task>/<org>__<name>/` with a `meta.json` and a
//! `.complete` marker that is written only after every file has arrived and
//! been size-checked. Deleting a model removes that folder and nothing else
//! is ever written for it, so no leftovers stay on the disk.

pub mod hub;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Task {
    Stt,
    Translation,
    Tts,
    Speaker,
}

impl Task {
    pub const ALL: [Task; 4] = [Task::Stt, Task::Translation, Task::Tts, Task::Speaker];

    pub fn pipeline_tag(&self) -> &'static str {
        match self {
            Task::Stt         => "automatic-speech-recognition",
            Task::Translation => "translation",
            Task::Tts         => "text-to-speech",
            Task::Speaker     => "audio-xvector",
        }
    }

    pub fn folder(&self) -> &'static str {
        match self {
            Task::Stt         => "stt",
            Task::Translation => "translation",
            Task::Tts         => "tts",
            Task::Speaker     => "speaker",
        }
    }
}

/// Which engine runs a model: the built-in Rust one (candle), the embedded
/// Python runtime (transformers) that handles almost every other checkpoint,
/// or MLX (Apple silicon GPU) through the same embedded Python runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    #[default]
    Native,
    Python,
    Mlx,
}

impl Backend {
    /// True when the model runs inside the embedded Python runtime.
    pub fn needs_python(&self) -> bool {
        matches!(self, Backend::Python | Backend::Mlx)
    }

    /// The engine name the Python worker understands.
    pub fn engine_name(&self) -> &'static str {
        match self {
            Backend::Mlx => "mlx",
            _            => "hf",
        }
    }
}

/// MLX only runs on Apple silicon.
pub const MLX_SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelMeta {
    pub id         : String,
    pub task       : Task,
    #[serde(default)]
    pub backend    : Backend,
    pub src_lang   : Option<String>,
    pub tgt_lang   : Option<String>,
    pub size_bytes : u64,
}

pub fn slug(id: &str) -> String {
    id.replace('/', "__")
}

pub fn model_dir(models_dir: &Path, task: Task, id: &str) -> PathBuf {
    models_dir.join(task.folder()).join(slug(id))
}

pub fn is_complete(dir: &Path) -> bool {
    dir.join(".complete").exists()
}

pub fn read_meta(dir: &Path) -> Option<ModelMeta> {
    let bytes = fs::read(dir.join("meta.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn list_installed(models_dir: &Path, task: Option<Task>) -> Vec<ModelMeta> {
    let tasks = match task {
        Some(t) => vec![t],
        None    => Task::ALL.to_vec(),
    };

    let mut out = Vec::new();

    for task in tasks {
        let Ok(entries) = fs::read_dir(models_dir.join(task.folder())) else { continue };

        for entry in entries.flatten() {
            let dir = entry.path();

            if !is_complete(&dir) {
                continue;
            }

            if let Some(meta) = read_meta(&dir) {
                out.push(meta);
            }
        }
    }

    out
}

/// Removes the task folder when nothing is left in it.
pub fn sweep_empty_task_dir(models_dir: &Path, task: Task) {
    let parent = models_dir.join(task.folder());

    if fs::read_dir(&parent).map(|mut d| d.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(&parent);
    }
}

/// Removes a model folder completely, and the task folder too once it is empty.
pub fn delete(models_dir: &Path, task: Task, id: &str) -> Result<()> {
    let dir = model_dir(models_dir, task, id);

    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }

    sweep_empty_task_dir(models_dir, task);

    Ok(())
}

/// Deletes folders left behind by a download that never finished (a crash, or
/// the app closed mid-download). Call it at startup, when nothing is downloading.
pub fn sweep_incomplete(models_dir: &Path) {
    for task in Task::ALL {
        let Ok(entries) = fs::read_dir(models_dir.join(task.folder())) else { continue };

        for entry in entries.flatten() {
            let dir = entry.path();

            if dir.is_dir() && !is_complete(&dir) {
                let _ = fs::remove_dir_all(&dir);
            }
        }

        let parent = models_dir.join(task.folder());

        if fs::read_dir(&parent).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = fs::remove_dir(&parent);
        }
    }
}

/// Total size of a folder, counting every file inside it.
pub fn tree_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };

    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => tree_size(&entry.path()),
            Ok(meta)                  => meta.len(),
            Err(_)                    => 0,
        })
        .sum()
}

/// "Helsinki-NLP/opus-mt-fr-en" gives ("fr", "en"); "opus-mt-tc-big-fr-en" too.
pub fn parse_pair(id: &str) -> Option<(String, String)> {
    let name  = id.rsplit('/').next()?;
    let parts: Vec<&str> = name.split('-').collect();

    if parts.len() < 2 {
        return None;
    }

    let src = parts[parts.len() - 2];
    let tgt = parts[parts.len() - 1];

    let valid = |s: &str| (2..=3).contains(&s.len()) && s.chars().all(|c| c.is_ascii_lowercase());

    (valid(src) && valid(tgt)).then(|| (src.to_string(), tgt.to_string()))
}

/// Marian repositories on the Hub ship SentencePiece files, which the Rust
/// tokenizers crate cannot read. The `lmz/candle-marian` repository hosts
/// converted `tokenizer.json` files, but only for English and French. (The
/// Python backend reads SentencePiece directly, so it has no such limit.)
pub fn builtin_marian_tokenizers(id: &str) -> Option<(String, String)> {
    let (src, tgt) = parse_pair(id)?;
    let covered    = |lang: &str| lang == "en" || lang == "fr";

    if !(covered(&src) && covered(&tgt)) {
        return None;
    }

    let prefix = if id.contains("tc-big") {
        "tokenizer-marian-"
    } else {
        "tokenizer-marian-base-"
    };

    Some((format!("{prefix}{src}.json"), format!("{prefix}{tgt}.json")))
}
