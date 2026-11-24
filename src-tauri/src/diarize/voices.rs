//! Voice profiles: named people the app recognises by voice, across meetings.
//!
//! A profile is the averaged speaker embedding of one person plus their name.
//! It is only comparable to embeddings made by the same speaker model, so the
//! model id is stored with it and profiles from another model are ignored.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// The best profile must beat the runner-up by this much (cosine distance),
/// otherwise two similar voices could swap names.
const MARGIN: f32 = 0.02;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceProfile {
    pub id      : String,
    pub name    : String,
    pub model   : String,
    pub vector  : Vec<f32>,
    pub samples : u32,
    pub created : u64,
}

/// What the interface sees: no raw embedding.
#[derive(Debug, Clone, Serialize)]
pub struct VoiceInfo {
    pub id      : String,
    pub name    : String,
    pub samples : u32,
    pub created : u64,
}

impl From<&VoiceProfile> for VoiceInfo {
    fn from(profile: &VoiceProfile) -> Self {
        Self {
            id      : profile.id.clone(),
            name    : profile.name.clone(),
            samples : profile.samples,
            created : profile.created,
        }
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na : f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb : f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
}

pub fn unit(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();

    if norm > 0.0 {
        vector.iter_mut().for_each(|x| *x /= norm);
    }

    vector
}

/// Index of the profile that matches `vector`, if one is close enough and clearly
/// closer than every other profile. `max_distance` is a cosine distance.
pub fn best_match(profiles: &[VoiceProfile], model: &str, vector: &[f32], max_distance: f32) -> Option<usize> {
    let mut ranked: Vec<(usize, f32)> = profiles
        .iter()
        .enumerate()
        .filter(|(_, p)| p.model == model && p.vector.len() == vector.len())
        .map(|(i, p)| (i, 1.0 - cosine(vector, &p.vector)))
        .collect();

    ranked.sort_by(|a, b| a.1.total_cmp(&b.1));

    let (index, best) = *ranked.first()?;

    if best > max_distance {
        return None;
    }

    match ranked.get(1) {
        Some((_, second)) if second - best < MARGIN => None,
        _                                           => Some(index),
    }
}

/// Folds one more sample of the same person into a profile (weighted mean).
pub fn merge(profile: &mut VoiceProfile, vector: &[f32], samples: u32) {
    if profile.vector.len() != vector.len() {
        profile.vector  = vector.to_vec();
        profile.samples = samples;

        return;
    }

    let old = profile.samples.max(1) as f32;
    let new = samples.max(1) as f32;

    for (p, v) in profile.vector.iter_mut().zip(vector) {
        *p = (*p * old + v * new) / (old + new);
    }

    profile.vector   = unit(std::mem::take(&mut profile.vector));
    profile.samples += samples;
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct VoiceStore {
    path     : PathBuf,
    pub list : Vec<VoiceProfile>,
}

impl VoiceStore {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("voices.json");
        let list = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();

        Self { path, list }
    }

    /// Reads the file again, for when another part of the app changed it.
    pub fn reload(&mut self) {
        self.list = fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
    }

    pub fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Write beside the file, then rename, so a crash never leaves half a file.
        let temp = self.path.with_extension("json.tmp");

        fs::write(&temp, serde_json::to_vec_pretty(&self.list)?)
            .with_context(|| format!("writing {}", temp.display()))?;
        fs::rename(&temp, &self.path).with_context(|| format!("writing {}", self.path.display()))
    }

    /// Adds a person, or folds the sample into the profile that already has this name.
    pub fn upsert(&mut self, name: &str, model: &str, vector: Vec<f32>, samples: u32) -> Result<VoiceProfile> {
        let name = name.trim();

        if name.is_empty() {
            bail!("Give this voice a name");
        }

        let vector = unit(vector);

        let existing = self
            .list
            .iter()
            .position(|p| p.model == model && p.name.eq_ignore_ascii_case(name));

        let profile = match existing {
            Some(i) => {
                merge(&mut self.list[i], &vector, samples);
                self.list[i].clone()
            }
            None => {
                let created = now_ms();
                let profile = VoiceProfile {
                    id      : format!("{created:x}{:02x}", self.list.len() % 256),
                    name    : name.to_string(),
                    model   : model.to_string(),
                    vector,
                    samples,
                    created,
                };

                self.list.push(profile.clone());
                profile
            }
        };

        self.save()?;

        Ok(profile)
    }

    pub fn remove(&mut self, id: &str) -> Result<bool> {
        let before = self.list.len();

        self.list.retain(|p| p.id != id);

        if self.list.len() == before {
            return Ok(false);
        }

        self.save()?;

        Ok(true)
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<()> {
        let name = name.trim();

        if name.is_empty() {
            bail!("A voice needs a name");
        }

        let profile = self.list.iter_mut().find(|p| p.id == id).context("That voice no longer exists")?;

        profile.name = name.to_string();

        self.save()
    }

    pub fn infos(&self) -> Vec<VoiceInfo> {
        let mut infos: Vec<VoiceInfo> = self.list.iter().map(VoiceInfo::from).collect();

        infos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        infos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(name: &str, model: &str, vector: &[f32]) -> VoiceProfile {
        VoiceProfile {
            id      : name.to_string(),
            name    : name.to_string(),
            model   : model.to_string(),
            vector  : unit(vector.to_vec()),
            samples : 3,
            created : 0,
        }
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("voices-test-{tag}-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn matches_the_closest_voice() {
        let list = vec![profile("Dara", "m", &[1.0, 0.0, 0.0]), profile("Sophea", "m", &[0.0, 1.0, 0.0])];

        assert_eq!(best_match(&list, "m", &unit(vec![0.95, 0.1, 0.0]), 0.2), Some(0));
        assert_eq!(best_match(&list, "m", &unit(vec![0.1, 0.95, 0.0]), 0.2), Some(1));
    }

    #[test]
    fn a_stranger_matches_nobody() {
        let list = vec![profile("Dara", "m", &[1.0, 0.0, 0.0])];

        assert_eq!(best_match(&list, "m", &unit(vec![0.0, 0.0, 1.0]), 0.2), None);
    }

    #[test]
    fn two_equally_close_voices_match_nobody() {
        let list = vec![profile("A", "m", &[1.0, 0.05, 0.0]), profile("B", "m", &[1.0, -0.05, 0.0])];

        assert_eq!(best_match(&list, "m", &[1.0, 0.0, 0.0], 0.2), None);
    }

    #[test]
    fn profiles_of_another_model_are_ignored() {
        let list = vec![profile("Dara", "old-model", &[1.0, 0.0, 0.0])];

        assert_eq!(best_match(&list, "new-model", &[1.0, 0.0, 0.0], 0.2), None);
        assert_eq!(best_match(&list, "old-model", &[1.0, 0.0], 0.2), None, "different size");
    }

    #[test]
    fn merging_moves_toward_the_new_sample_and_stays_unit_length() {
        let mut p = profile("Dara", "m", &[1.0, 0.0]);

        merge(&mut p, &unit(vec![0.0, 1.0]), 3);

        assert_eq!(p.samples, 6);
        assert!((p.vector.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-5);
        assert!((p.vector[0] - p.vector[1]).abs() < 1e-5);
    }

    #[test]
    fn store_round_trips_and_merges_same_name() {
        let dir = scratch_dir("roundtrip");

        let mut store = VoiceStore::load(&dir);
        store.upsert("Dara", "m", vec![1.0, 0.0], 2).unwrap();
        store.upsert("dara", "m", vec![0.9, 0.1], 2).unwrap();
        store.upsert("Sophea", "m", vec![0.0, 1.0], 1).unwrap();

        let again = VoiceStore::load(&dir);

        assert_eq!(again.list.len(), 2);
        assert_eq!(again.list.iter().find(|p| p.name == "Dara").unwrap().samples, 4);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn remove_and_rename() {
        let dir = scratch_dir("edit");

        let mut store = VoiceStore::load(&dir);
        let dara      = store.upsert("Dara", "m", vec![1.0, 0.0], 1).unwrap();

        store.rename(&dara.id, "Dara K.").unwrap();
        assert_eq!(store.infos()[0].name, "Dara K.");
        assert!(store.rename(&dara.id, "  ").is_err());

        assert!(store.remove(&dara.id).unwrap());
        assert!(!store.remove(&dara.id).unwrap());
        assert!(VoiceStore::load(&dir).list.is_empty());

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn empty_name_is_refused() {
        let dir = scratch_dir("empty");

        assert!(VoiceStore::load(&dir).upsert("   ", "m", vec![1.0], 1).is_err());

        fs::remove_dir_all(dir).ok();
    }
}
