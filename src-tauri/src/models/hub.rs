//! Hugging Face Hub client: search by task, judge which engine can run a model
//! (built-in Rust, or the embedded Python runtime), and download it with
//! progress events.
//!
//! Only public repositories are supported (no access token).
//!
//! Storage hygiene: a model is downloaded into its own folder. Every file goes
//! through a `.part` file, is size-checked against the Hub listing, and only
//! then renamed. If anything fails, or the download is cancelled, the whole
//! model folder is removed, so a half-finished model never stays on the disk.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use super::{
    builtin_marian_tokenizers, is_complete, model_dir, parse_pair, tree_size, Backend, ModelMeta, Task,
    MLX_SUPPORTED,
};

const HUB: &str = "https://huggingface.co";

#[derive(Debug, Clone, Serialize)]
pub struct ModelCard {
    pub id          : String,
    pub task        : Task,
    pub backend     : Backend,
    pub downloads   : u64,
    pub likes       : u64,
    pub tags        : Vec<String>,
    pub compatible  : bool,
    pub note        : String,
    pub installed   : bool,
    pub size_bytes  : u64,
    pub recommended : bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Recommendation {
    pub id         : String,
    pub task       : Task,
    pub backend    : Backend,
    pub size_bytes : u64,
    pub note       : String,
    pub installed  : bool,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadEvent {
    id         : String,
    downloaded : u64,
    total      : u64,
    done       : bool,
}

struct PlanItem {
    url  : String,
    dest : String,
    size : u64,
    copy : Option<&'static str>,
}

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().user_agent("phasa/0.2").build()?)
}

fn urlencode(text: &str) -> String {
    let mut out = String::new();

    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }

    out
}

/// True for MLX checkpoints: the `mlx` tag, or an `mlx-*` library tag such as
/// `mlx-audio-plus`.
fn is_mlx(tags: &[String]) -> bool {
    tags.iter().any(|t| t == "mlx" || t.starts_with("mlx-"))
}

/// Whether an MLX repository is something the MLX worker can load for this task.
/// The error is the reason it cannot.
fn mlx_check(task: Task, id: &str, files: &HashSet<String>) -> std::result::Result<(), &'static str> {
    let has_weights = files.iter().any(|f| !f.contains('/') && (f.ends_with(".safetensors") || f.ends_with(".npz")));

    if !files.contains("config.json") {
        return Err("No config.json in this repository");
    }

    if !has_weights {
        return Err("No MLX weights in this repository");
    }

    let lower = id.to_lowercase();

    match task {
        Task::Speaker => Err("There are no MLX speaker models yet"),
        Task::Translation
            if ["nllb", "m2m", "opus-mt", "marian", "mbart"].iter().any(|k| lower.contains(k)) =>
        {
            Err("MLX translation here runs instruction models, not NLLB or Marian style models")
        }
        _ => Ok(()),
    }
}

/// Which engine can run a repository. Returns the backend and a note, or None
/// with the reason when no engine can.
pub fn assess(task: Task, id: &str, tags: &[String], files: &HashSet<String>) -> (Option<Backend>, String) {
    let tagged = |name: &str| tags.iter().any(|t| t == name);

    let native = match task {
        Task::Stt => {
            tagged("whisper") && files.contains("model.safetensors") && files.contains("tokenizer.json")
        }
        Task::Translation => {
            let has_weights   = files.contains("model.safetensors") || files.contains("pytorch_model.bin");
            let has_tokenizer = files.contains("tokenizer.json") || builtin_marian_tokenizers(id).is_some();

            tagged("marian") && has_weights && has_tokenizer
        }
        Task::Tts | Task::Speaker => false,
    };

    if native {
        return (Some(Backend::Native), "Runs in the built-in engine".into());
    }

    let mut mlx_note: Option<&str> = None;

    if is_mlx(tags) {
        match mlx_check(task, id, files) {
            Ok(()) if MLX_SUPPORTED => {
                return (Some(Backend::Mlx), "Runs on the Apple GPU with MLX".into());
            }
            Ok(())   => mlx_note = Some("MLX models need a Mac with Apple silicon"),
            Err(why) => mlx_note = Some(why),
        }
    }

    let has_weights = files.contains("model.safetensors")
        || files.contains("pytorch_model.bin")
        || files.iter().any(|f| f.ends_with(".safetensors") && !f.contains('/'))
        || files.iter().any(|f| f.starts_with("pytorch_model-") && f.ends_with(".bin"));

    let python_ok = tagged("transformers") && files.contains("config.json") && has_weights;

    if python_ok {
        (Some(Backend::Python), "Runs with the Python runtime (set it up in Storage)".into())
    } else if let Some(note) = mlx_note {
        (None, note.into())
    } else if !tagged("transformers") {
        (None, "Not a Transformers or MLX model, so no engine here can run it".into())
    } else if !files.contains("config.json") {
        (None, "No config.json in this repository".into())
    } else {
        (None, "No supported weights in this repository".into())
    }
}

fn recommended_list(task: Task, src: &str, tgt: &str) -> Vec<(String, Backend, u64, String)> {
    let mut out = if MLX_SUPPORTED { mlx_recommended(task) } else { Vec::new() };

    out.extend(portable_recommended(task, src, tgt));
    out
}

/// Apple GPU picks, shown first on a Mac with Apple silicon.
fn mlx_recommended(task: Task) -> Vec<(String, Backend, u64, String)> {
    const MB: u64 = 1_000_000;

    match task {
        Task::Stt => vec![
            ("mlx-community/whisper-large-v3-turbo".into(), Backend::Mlx, 1_614 * MB, "Best accuracy, fast on the Apple GPU".into()),
            ("mlx-community/whisper-small-mlx".into(),      Backend::Mlx,   481 * MB, "Light and quick, good for clear speech".into()),
            ("mlx-community/parakeet-tdt-0.6b-v3".into(),   Backend::Mlx, 2_509 * MB, "Very fast, 25 European languages".into()),
        ],
        Task::Translation => vec![
            ("mlx-community/Hy-MT2-1.8B-4bit".into(), Backend::Mlx, 1_017 * MB, "Translation model on the Apple GPU, many languages".into()),
        ],
        Task::Tts => vec![
            ("mlx-community/Kokoro-82M-bf16".into(), Backend::Mlx, 327 * MB, "Natural voices on the Apple GPU".into()),
        ],
        Task::Speaker => Vec::new(),
    }
}

fn portable_recommended(task: Task, src: &str, tgt: &str) -> Vec<(String, Backend, u64, String)> {
    const MB: u64 = 1_000_000;

    match task {
        Task::Stt => vec![
            ("openai/whisper-tiny".into(),  Backend::Native,  151 * MB, "Fastest, fine for clear speech".into()),
            ("openai/whisper-base".into(),  Backend::Native,  290 * MB, "Good balance on most laptops".into()),
            ("openai/whisper-small".into(), Backend::Native,  967 * MB, "Better accuracy, wants a fast CPU or a GPU".into()),
        ],
        Task::Translation => {
            let mut out = Vec::new();

            if src != "auto" && !src.is_empty() && !tgt.is_empty() && src != tgt {
                out.push((
                    format!("Helsinki-NLP/opus-mt-{src}-{tgt}"),
                    Backend::Native,
                    300 * MB,
                    "Small and fast, one language pair (not every pair exists)".into(),
                ));
            }

            out.push(("facebook/nllb-200-distilled-600M".into(), Backend::Python, 2_450 * MB, "200 languages in one model".into()));
            out.push(("facebook/m2m100_418M".into(),             Backend::Python, 1_940 * MB, "100 languages in one model".into()));
            out
        }
        Task::Tts => vec![
            ("facebook/mms-tts-eng".into(), Backend::Python, 145 * MB, "English voice; other languages are facebook/mms-tts-<code>".into()),
        ],
        Task::Speaker => vec![
            ("microsoft/wavlm-base-plus-sv".into(), Backend::Python, 380 * MB, "Tells speakers apart by voice".into()),
        ],
    }
}

/// True when the repository exists and can be listed anonymously. A missing
/// language pair answers 401 or 404.
async fn repo_exists(client: &reqwest::Client, id: &str) -> bool {
    match client.get(format!("{HUB}/api/models/{id}")).send().await {
        Ok(response) => response.status().is_success(),
        Err(_)       => true, // offline: keep the suggestion rather than hide it
    }
}

pub async fn recommended(task: Task, src: &str, tgt: &str, models_dir: &Path) -> Vec<Recommendation> {
    let mut list = recommended_list(task, src, tgt);

    // One-pair Marian models exist only for some pairs: keep the suggestion only if it does.
    if task == Task::Translation {
        if let Ok(client) = http() {
            let mut kept = Vec::with_capacity(list.len());

            for entry in list {
                if entry.0.starts_with("Helsinki-NLP/") && !repo_exists(&client, &entry.0).await {
                    continue;
                }

                kept.push(entry);
            }

            list = kept;
        }
    }

    list
        .into_iter()
        .map(|(id, backend, size_bytes, note)| Recommendation {
            installed: is_complete(&model_dir(models_dir, task, &id)),
            id,
            task,
            backend,
            size_bytes,
            note,
        })
        .collect()
}

/// Searches the Hub. `tag` narrows the search to one Hub tag, such as `mlx`
/// (Apple GPU) or `gpu`; an empty tag searches every model of the task.
pub async fn search(task: Task, query: &str, tag: &str, models_dir: &Path) -> Result<Vec<ModelCard>> {
    let query = query.trim();
    let tag   = tag.trim();

    // Many MLX translation models are tagged as plain text generation, so an
    // MLX search looks there too.
    let mut lookups: Vec<(&str, String)> = vec![(task.pipeline_tag(), query.to_string())];

    if task == Task::Translation && tag == "mlx" {
        lookups.push(("text-generation", if query.is_empty() { "translate".into() } else { query.to_string() }));
    }

    let client = http()?;
    let mut items: Vec<Value> = Vec::new();

    for (pipeline, term) in lookups {
        let mut url = format!(
            "{HUB}/api/models?pipeline_tag={pipeline}&sort=downloads&direction=-1&limit=24&full=true"
        );

        if !tag.is_empty() {
            url.push_str(&format!("&filter={}", urlencode(tag)));
        }

        if !term.is_empty() {
            url.push_str(&format!("&search={}", urlencode(&term)));
        }

        let found: Vec<Value> = client
            .get(&url)
            .send()
            .await?
            .error_for_status()
            .context("Hugging Face search failed")?
            .json()
            .await?;

        items.extend(found);
    }

    items.sort_by_key(|item| std::cmp::Reverse(item["downloads"].as_u64().unwrap_or(0)));

    let recommended_ids: HashSet<String> = recommended_list(task, "", "")
        .into_iter()
        .map(|(id, ..)| id)
        .collect();

    let mut seen  = HashSet::new();
    let mut cards = Vec::new();

    for item in items {
        let Some(id) = item["id"].as_str() else { continue };

        if !seen.insert(id.to_string()) {
            continue;
        }

        let tags: Vec<String> = item["tags"]
            .as_array()
            .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let files: HashSet<String> = item["siblings"]
            .as_array()
            .map(|a| a.iter().filter_map(|s| s["rfilename"].as_str().map(String::from)).collect())
            .unwrap_or_default();

        let (backend, note) = assess(task, id, &tags, &files);

        // Tags worth showing first: the hardware ones, then the rest.
        let mut shown: Vec<String> = tags
            .iter()
            .filter(|t| matches!(t.as_str(), "mlx" | "gpu" | "gguf" | "coreml" | "onnx" | "whisper"))
            .cloned()
            .collect();

        let rest: Vec<String> = tags
            .iter()
            .filter(|t| !shown.contains(*t) && !t.contains(':'))
            .cloned()
            .collect();

        shown.extend(rest);

        cards.push(ModelCard {
            id          : id.to_string(),
            task,
            backend     : backend.unwrap_or_default(),
            downloads   : item["downloads"].as_u64().unwrap_or(0),
            likes       : item["likes"].as_u64().unwrap_or(0),
            tags        : shown.into_iter().take(10).collect(),
            compatible  : backend.is_some(),
            note,
            installed   : is_complete(&model_dir(models_dir, task, id)),
            size_bytes  : item["usedStorage"].as_u64().unwrap_or(0),
            recommended : recommended_ids.contains(id),
        });
    }

    cards.truncate(30);

    Ok(cards)
}

async fn repo_files(client: &reqwest::Client, id: &str) -> Result<HashMap<String, u64>> {
    let info: Value = client
        .get(format!("{HUB}/api/models/{id}?blobs=true"))
        .send()
        .await?
        .error_for_status()
        .with_context(|| format!("cannot read repository {id}"))?
        .json()
        .await?;

    let mut files = HashMap::new();

    for sibling in info["siblings"].as_array().cloned().unwrap_or_default() {
        if let Some(name) = sibling["rfilename"].as_str() {
            files.insert(name.to_string(), sibling["size"].as_u64().unwrap_or(0));
        }
    }

    Ok(files)
}

/// Root-level files a transformers model needs: configs, tokenizers, weights.
/// Pickle weights are taken only when the repository has no safetensors.
fn python_plan(id: &str, files: &HashMap<String, u64>) -> Result<Vec<PlanItem>> {
    let has_safetensors = files.keys().any(|f| !f.contains('/') && f.ends_with(".safetensors"));

    let wanted = |name: &str| -> bool {
        if name.contains('/') || name.starts_with('.') {
            return false;
        }

        let ext = name.rsplit('.').next().unwrap_or("");

        match ext {
            "json" | "txt" | "model" | "spm" | "vocab" | "tiktoken" | "safetensors" => true,
            "bin" => !has_safetensors && name.starts_with("pytorch_model"),
            _     => false,
        }
    };

    let mut names: Vec<&String> = files.keys().filter(|f| wanted(f)).collect();
    names.sort();

    if !names.iter().any(|n| n.as_str() == "config.json") {
        bail!("{id} has no config.json");
    }

    if names.iter().all(|n| !n.ends_with(".safetensors") && !n.ends_with(".bin")) {
        bail!("{id} has no weights this runtime can load");
    }

    Ok(names
        .into_iter()
        .map(|name| PlanItem {
            url  : format!("{HUB}/{id}/resolve/main/{name}"),
            dest : name.clone(),
            size : files[name],
            copy : None,
        })
        .collect())
}

/// Files an MLX checkpoint needs: configs, tokenizers, weights (`.safetensors`
/// or Whisper's `.npz`), chat templates, and for speech synthesis the voice
/// packs. Documentation, samples and pickled voices are left out.
fn mlx_plan(task: Task, id: &str, files: &HashMap<String, u64>) -> Result<Vec<PlanItem>> {
    let wanted = |name: &str| -> bool {
        if name.starts_with('.') {
            return false;
        }

        if let Some(rest) = name.strip_prefix("voices/") {
            return task == Task::Tts && !rest.contains('/') && rest.ends_with(".safetensors");
        }

        if name.contains('/') {
            return false;
        }

        let ext = name.rsplit('.').next().unwrap_or("");

        matches!(ext, "json" | "txt" | "model" | "spm" | "vocab" | "tiktoken" | "jinja" | "safetensors" | "npz")
    };

    let mut names: Vec<&String> = files.keys().filter(|f| wanted(f)).collect();
    names.sort();

    if !names.iter().any(|n| n.as_str() == "config.json") {
        bail!("{id} has no config.json");
    }

    if names.iter().all(|n| !n.ends_with(".safetensors") && !n.ends_with(".npz")) {
        bail!("{id} has no MLX weights");
    }

    Ok(names
        .into_iter()
        .map(|name| PlanItem {
            url  : format!("{HUB}/{id}/resolve/main/{name}"),
            dest : name.clone(),
            size : files[name],
            copy : None,
        })
        .collect())
}

fn native_plan(task: Task, id: &str, files: &HashMap<String, u64>) -> Result<Vec<PlanItem>> {
    let item = |repo: &str, file: &str, dest: &str, size: u64, copy: Option<&'static str>| PlanItem {
        url  : format!("{HUB}/{repo}/resolve/main/{file}"),
        dest : dest.to_string(),
        size,
        copy,
    };

    let from_repo = |file: &str| -> Result<PlanItem> {
        let size = *files.get(file).ok_or_else(|| anyhow!("{id} has no {file}"))?;
        Ok(item(id, file, file, size, None))
    };

    let mut out = Vec::new();

    match task {
        Task::Stt => {
            out.push(from_repo("config.json")?);
            out.push(from_repo("tokenizer.json")?);
            out.push(from_repo("model.safetensors")?);
        }
        Task::Translation => {
            out.push(from_repo("config.json")?);

            if files.contains_key("model.safetensors") {
                out.push(from_repo("model.safetensors")?);
            } else {
                out.push(from_repo("pytorch_model.bin")?);
            }

            if let Some(size) = files.get("tokenizer.json") {
                // One file serves as both source and target tokenizer.
                out.push(item(id, "tokenizer.json", "tokenizer-src.json", *size, Some("tokenizer-tgt.json")));
            } else if let Some((src, tgt)) = builtin_marian_tokenizers(id) {
                out.push(item("lmz/candle-marian", &src, "tokenizer-src.json", 0, None));
                out.push(item("lmz/candle-marian", &tgt, "tokenizer-tgt.json", 0, None));
            } else {
                bail!("{id} has no tokenizer.json and no built-in tokenizer for this language pair");
            }
        }
        Task::Tts | Task::Speaker => bail!("{id} can only run on the Python runtime"),
    }

    Ok(out)
}

fn emit(app: &AppHandle, id: &str, downloaded: u64, total: u64, done: bool) {
    let _ = app.emit(
        "model-download",
        DownloadEvent { id: id.to_string(), downloaded, total, done },
    );
}

/// Downloads a model. On any failure or cancellation the model folder is
/// removed completely before the error is returned.
pub async fn download(
    app        : &AppHandle,
    models_dir : &Path,
    id         : &str,
    task       : Task,
    backend    : Backend,
    cancel     : Arc<AtomicBool>,
) -> Result<()> {
    let dir = model_dir(models_dir, task, id);

    if is_complete(&dir) {
        emit(app, id, 1, 1, true);
        return Ok(());
    }

    // A leftover folder from an earlier failed attempt is never reused.
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }

    let result = fetch(app, models_dir, id, task, backend, cancel).await;

    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
        super::sweep_empty_task_dir(models_dir, task);
    }

    result
}

async fn fetch(
    app        : &AppHandle,
    models_dir : &Path,
    id         : &str,
    task       : Task,
    backend    : Backend,
    cancel     : Arc<AtomicBool>,
) -> Result<()> {
    let client = http()?;
    let files  = repo_files(&client, id).await?;

    let items = match backend {
        Backend::Native => native_plan(task, id, &files)?,
        Backend::Python => python_plan(id, &files)?,
        Backend::Mlx    => mlx_plan(task, id, &files)?,
    };

    let dir = model_dir(models_dir, task, id);
    std::fs::create_dir_all(&dir)?;

    let total          = items.iter().map(|i| i.size).sum::<u64>();
    let mut downloaded = 0_u64;
    let mut last_emit: Option<Instant> = None;

    emit(app, id, 0, total, false);

    for item in &items {
        let dest = dir.join(&item.dest);
        let part = dir.join(format!("{}.part", item.dest));

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let response = client
            .get(&item.url)
            .send()
            .await?
            .error_for_status()
            .with_context(|| format!("download failed: {}", item.url))?;

        let mut file    = tokio::fs::File::create(&part).await?;
        let mut stream  = response.bytes_stream();
        let mut written = 0_u64;

        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                bail!("download cancelled");
            }

            let chunk = chunk?;
            file.write_all(&chunk).await?;
            written    += chunk.len() as u64;
            downloaded += chunk.len() as u64;

            let due = last_emit.map_or(true, |t| t.elapsed() > Duration::from_millis(120));

            if due {
                emit(app, id, downloaded, total.max(downloaded), false);
                last_emit = Some(Instant::now());
            }
        }

        file.flush().await?;
        drop(file);

        if item.size > 0 && written != item.size {
            bail!("{} arrived incomplete ({written} of {} bytes)", item.dest, item.size);
        }

        tokio::fs::rename(&part, &dest).await?;

        if let Some(copy) = item.copy {
            tokio::fs::copy(&dest, dir.join(copy)).await?;
        }
    }

    let (src_lang, tgt_lang) = match task {
        Task::Translation => parse_pair(id).map(|(s, t)| (Some(s), Some(t))).unwrap_or((None, None)),
        _                 => (None, None),
    };

    let meta = ModelMeta {
        id         : id.to_string(),
        task,
        backend,
        src_lang   : if backend == Backend::Native { src_lang } else { None },
        tgt_lang   : if backend == Backend::Native { tgt_lang } else { None },
        size_bytes : tree_size(&dir),
    };

    std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta)?)?;
    std::fs::write(dir.join(".complete"), b"ok")?;

    emit(app, id, downloaded, downloaded, true);

    Ok(())
}
