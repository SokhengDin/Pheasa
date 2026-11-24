//! Speaker identification with a neural speaker-embedding model (x-vector) that
//! runs in the Python runtime.
//!
//! Each finished utterance becomes a unit vector. It is first compared with the
//! saved voice profiles (people the user named), and a match takes that person's
//! name. A voice nobody has named is grouped by cosine distance to running
//! centroids and shown as "Speaker A", "Speaker B"... until it is named.

use std::path::Path;

use anyhow::{bail, Result};
use serde_json::json;

use super::voices::{self, VoiceStore};
use super::{speaker_name, Label};
use crate::audio::SAMPLE_RATE;
use crate::runtime;

/// One second is enough to look a voice up.
const MATCH_SAMPLES : usize = SAMPLE_RATE as usize;

/// A new unknown voice needs a longer sample, so a cough or a "yes" never
/// invents a speaker.
const NEW_SAMPLES   : usize = SAMPLE_RATE as usize * 3 / 2;

/// A new unknown voice must also be clearly farther than the threshold.
const NEW_MARGIN    : f32   = 1.25;

const MAX_SPEAKERS  : usize = 8;

struct Centroid {
    vector : Vec<f32>,
    count  : usize,
}

#[derive(Clone, Copy)]
enum Who {
    Profile(usize),
    Cluster(usize),
}

pub struct EmbedLabeler {
    model     : String,
    store     : VoiceStore,
    centroids : Vec<Centroid>,
    last      : Option<Who>,
    threshold : f32,
}

impl EmbedLabeler {
    /// `threshold` is the user's 0..1 setting; cosine distances between
    /// different speakers sit well below 1, so it is scaled down.
    pub fn load(dir: &Path, device: &str, threshold: f32, model_id: &str, data_dir: &Path) -> Result<Self> {
        runtime::call(
            "load_embed",
            json!({ "model_dir": dir.to_string_lossy(), "device": device }),
            None,
        )?;

        Ok(Self {
            model     : model_id.to_string(),
            store     : VoiceStore::load(data_dir),
            centroids : Vec::new(),
            last      : None,
            threshold : threshold * 0.45,
        })
    }

    /// Re-reads the saved voices (after one was added, renamed or deleted elsewhere).
    pub fn reload(&mut self) {
        self.store.reload();
        self.last = self.last.filter(|who| !matches!(who, Who::Profile(_)));
    }

    fn describe(&self, who: Option<Who>) -> Label {
        match who {
            Some(Who::Profile(i)) => match self.store.list.get(i) {
                Some(profile) => Label { name: profile.name.clone(), known: true },
                None          => Label { name: speaker_name(0), known: false },
            },
            Some(Who::Cluster(i)) => Label { name: speaker_name(i), known: false },
            None                  => Label { name: speaker_name(0), known: false },
        }
    }

    fn embed(&self, pcm: &[f32]) -> Option<Vec<f32>> {
        let reply = runtime::call("embed", json!({}), Some(pcm)).ok()?;

        let vector: Vec<f32> = reply["vector"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_f64()).map(|v| v as f32).collect())
            .unwrap_or_default();

        (!vector.is_empty()).then_some(vector)
    }

    pub fn label(&mut self, pcm: &[f32], commit: bool) -> Label {
        if pcm.len() < MATCH_SAMPLES {
            return self.describe(self.last);
        }

        let Some(vector) = self.embed(pcm) else {
            return self.describe(self.last);
        };

        // 1. Someone the user has named.
        if let Some(i) = voices::best_match(&self.store.list, &self.model, &vector, self.threshold) {
            let who = Who::Profile(i);

            if commit {
                self.last = Some(who);
            }

            return self.describe(Some(who));
        }

        // 2. A voice heard earlier in this session.
        let nearest = self
            .centroids
            .iter()
            .enumerate()
            .map(|(i, c)| (i, 1.0 - voices::cosine(&vector, &c.vector)))
            .min_by(|a, b| a.1.total_cmp(&b.1));

        let may_create = pcm.len() >= NEW_SAMPLES && self.centroids.len() < MAX_SPEAKERS;

        let index = match nearest {
            Some((i, d)) if d <= self.threshold                      => i,
            Some((i, d)) if !may_create || d <= self.threshold * NEW_MARGIN => i,
            _                                                        => self.centroids.len(),
        };

        // A short clip with no earlier voice to compare to is not worth a new speaker.
        if index == self.centroids.len() && !may_create && nearest.is_none() {
            return self.describe(self.last);
        }

        if commit {
            if index == self.centroids.len() {
                self.centroids.push(Centroid { vector, count: 1 });
            } else {
                let centroid = &mut self.centroids[index];
                let n        = centroid.count as f32;

                for (c, v) in centroid.vector.iter_mut().zip(&vector) {
                    *c = (*c * n + v) / (n + 1.0);
                }

                centroid.count += 1;
            }

            self.last = Some(Who::Cluster(index));
        }

        self.describe(Some(Who::Cluster(index)))
    }

    /// Saves the voice behind an unknown speaker label ("Speaker B") under a name.
    /// From then on that voice is recognised in this meeting and every later one.
    pub fn remember(&mut self, label: &str, name: &str) -> Result<String> {
        let Some(index) = (0..self.centroids.len()).find(|&i| speaker_name(i) == label) else {
            bail!("{label} has not spoken in this session, so there is no voice to save");
        };

        let centroid = &self.centroids[index];
        let profile  = self.store.upsert(name, &self.model, centroid.vector.clone(), centroid.count as u32)?;

        self.last = None;

        Ok(profile.name)
    }
}
