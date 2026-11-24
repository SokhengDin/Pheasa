//! Saved conversations. Each session is one JSON file in `<app data>/sessions`,
//! written to a temporary name first and renamed, so a crash never leaves a
//! half-written file. Deleting a session deletes its file.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id          : u64,
    pub title       : String,
    pub source_lang : String,
    pub target_lang : String,
    pub entries     : Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id          : u64,
    pub title       : String,
    pub source_lang : String,
    pub target_lang : String,
    pub count       : usize,
    pub preview     : String,
    pub size_bytes  : u64,
    pub matches     : usize,
}

fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sessions")
}

fn file(data_dir: &Path, id: u64) -> PathBuf {
    dir(data_dir).join(format!("{id}.json"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn save(
    data_dir    : &Path,
    title       : String,
    source_lang : String,
    target_lang : String,
    entries     : Vec<Value>,
) -> Result<u64> {
    if entries.is_empty() {
        return Err(anyhow!("There is nothing to save yet"));
    }

    fs::create_dir_all(dir(data_dir))?;

    let id      = now_ms();
    let session = Session { id, title, source_lang, target_lang, entries };

    let target = file(data_dir, id);
    let temp   = target.with_extension("json.tmp");

    fs::write(&temp, serde_json::to_vec(&session)?)?;
    fs::rename(&temp, &target)?;

    Ok(id)
}

pub fn load(data_dir: &Path, id: u64) -> Result<Session> {
    Ok(serde_json::from_slice(&fs::read(file(data_dir, id))?)?)
}

fn text_of(entry: &Value) -> String {
    let text = entry["text"].as_str().unwrap_or("");
    let tr   = entry["translation"].as_str().unwrap_or("");

    format!("{text}\n{tr}").to_lowercase()
}

/// Newest first. With a query, only sessions that mention it, with a count.
pub fn list(data_dir: &Path, query: &str) -> Vec<SessionInfo> {
    let needle = query.trim().to_lowercase();
    let mut out = Vec::new();

    let Ok(entries) = fs::read_dir(dir(data_dir)) else { return out };

    for item in entries.flatten() {
        let path = item.path();

        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let Ok(bytes)   = fs::read(&path) else { continue };
        let Ok(session) = serde_json::from_slice::<Session>(&bytes) else { continue };

        let matches = if needle.is_empty() {
            0
        } else {
            session.entries.iter().filter(|e| text_of(e).contains(&needle)).count()
        };

        if !needle.is_empty() && matches == 0 && !session.title.to_lowercase().contains(&needle) {
            continue;
        }

        let preview = session
            .entries
            .iter()
            .find_map(|e| e["text"].as_str())
            .unwrap_or("")
            .chars()
            .take(120)
            .collect();

        out.push(SessionInfo {
            id          : session.id,
            title       : session.title,
            source_lang : session.source_lang,
            target_lang : session.target_lang,
            count       : session.entries.len(),
            preview,
            size_bytes  : bytes.len() as u64,
            matches,
        });
    }

    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

pub fn delete(data_dir: &Path, id: u64) -> Result<()> {
    let path = file(data_dir, id);

    if path.exists() {
        fs::remove_file(path)?;
    }

    remove_dir_if_empty(data_dir);

    Ok(())
}

/// Deletes every session and the folder itself.
pub fn clear(data_dir: &Path) -> Result<()> {
    let folder = dir(data_dir);

    if folder.exists() {
        fs::remove_dir_all(folder)?;
    }

    Ok(())
}

pub fn size(data_dir: &Path) -> u64 {
    crate::models::tree_size(&dir(data_dir))
}

/// Leftover temporary files from a crash while saving.
pub fn sweep(data_dir: &Path) {
    let Ok(entries) = fs::read_dir(dir(data_dir)) else { return };

    for item in entries.flatten() {
        let path = item.path();

        if path.extension().and_then(|e| e.to_str()) == Some("tmp") {
            let _ = fs::remove_file(path);
        }
    }

    remove_dir_if_empty(data_dir);
}

fn remove_dir_if_empty(data_dir: &Path) {
    let folder = dir(data_dir);

    if fs::read_dir(&folder).map(|mut d| d.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(folder);
    }
}
