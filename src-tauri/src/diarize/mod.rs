//! Speaker labels.
//!
//! The microphone is always "You". System audio mixes every remote person into
//! one stream, so it is split into "Speaker A", "Speaker B" and so on with a
//! light online clusterer over each finished utterance (spectral shape plus
//! pitch). It needs no model files, but it is a heuristic: labels can swap in
//! the first few seconds and similar voices can merge. Tune the threshold in
//! Settings. A neural speaker-embedding model can replace `ClusterLabeler`
//! behind the same `Labeler::label` call.

pub mod embed;
pub mod enroll;
pub mod voices;

use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

use crate::audio::{Source, SAMPLE_RATE};

const N_FFT        : usize = 512;
const WINDOW       : usize = 400;
const HOP          : usize = 160;
const BANDS        : usize = 24;
const MIN_SAMPLES  : usize = SAMPLE_RATE as usize;   // need at least 1 s of audio
const MAX_SPEAKERS : usize = 6;
const PITCH_WINDOW : usize = 640;
const PITCH_HOP    : usize = 320;

/// Who spoke. `known` is true for "You" and for people with a saved voice;
/// false for a voice nobody has named yet ("Speaker B").
#[derive(Debug, Clone)]
pub struct Label {
    pub name  : String,
    pub known : bool,
}

pub struct Labeler {
    cluster : Option<ClusterLabeler>,
    neural  : Option<embed::EmbedLabeler>,
}

impl Labeler {
    pub fn new(separate_remote: bool, threshold: f32) -> Self {
        Self {
            cluster : separate_remote.then(|| ClusterLabeler::new(threshold)),
            neural  : None,
        }
    }

    /// Use a speaker-embedding model instead of the built-in clusterer.
    pub fn with_neural(mut self, neural: Option<embed::EmbedLabeler>) -> Self {
        self.neural = neural;
        self
    }

    /// True when voices are told apart by a model (and can be saved by name).
    pub fn has_voice_model(&self) -> bool {
        self.neural.is_some()
    }

    /// `commit` decides whether this utterance may create or update a speaker
    /// (final segments) or only look one up (live previews).
    pub fn label(&mut self, source: Source, pcm: &[f32], commit: bool) -> Label {
        match source {
            Source::Mic => Label { name: "You".to_string(), known: true },
            Source::System => {
                if let Some(neural) = self.neural.as_mut() {
                    return neural.label(pcm, commit);
                }

                match self.cluster.as_mut() {
                    Some(cluster) => Label { name: cluster.label(pcm, commit), known: false },
                    None          => Label { name: "Remote".to_string(), known: false },
                }
            }
        }
    }

    /// Saves the voice behind an unknown speaker under a name.
    pub fn remember(&mut self, label: &str, name: &str) -> anyhow::Result<String> {
        match self.neural.as_mut() {
            Some(neural) => neural.remember(label, name),
            None         => anyhow::bail!("Choose a speaker model in Models and Settings first: the basic method cannot recognise a voice again"),
        }
    }

    /// Picks up voices that were added, renamed or deleted while this meeting runs.
    pub fn reload_voices(&mut self) {
        if let Some(neural) = self.neural.as_mut() {
            neural.reload();
        }
    }
}

struct Embedding {
    shape : Vec<f32>,
    pitch : Option<f32>,
}

struct Centroid {
    shape : Vec<f32>,
    pitch : Option<f32>,
    count : usize,
}

struct ClusterLabeler {
    centroids : Vec<Centroid>,
    last      : usize,
    threshold : f32,
    fft       : Arc<dyn Fft<f32>>,
    window    : Vec<f32>,
    filters   : Vec<(usize, Vec<f32>)>,
}

impl ClusterLabeler {
    fn new(threshold: f32) -> Self {
        let fft    = FftPlanner::<f32>::new().plan_fft_forward(N_FFT);
        let window = (0..WINDOW)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WINDOW as f32).cos())
            .collect();

        Self {
            centroids : Vec::new(),
            last      : 0,
            threshold,
            fft,
            window,
            filters   : band_filters(),
        }
    }

    fn label(&mut self, pcm: &[f32], commit: bool) -> String {
        let Some(embedding) = self.embed(pcm) else {
            return speaker_name(self.last);
        };

        let nearest = self
            .centroids
            .iter()
            .enumerate()
            .map(|(i, c)| (i, distance(&embedding, c)))
            .min_by(|a, b| a.1.total_cmp(&b.1));

        let index = match nearest {
            Some((i, d)) if d <= self.threshold => i,
            Some((i, _)) if self.centroids.len() >= MAX_SPEAKERS => i,
            _ => self.centroids.len(),
        };

        if commit {
            if index == self.centroids.len() {
                self.centroids.push(Centroid {
                    shape : embedding.shape,
                    pitch : embedding.pitch,
                    count : 1,
                });
            } else {
                let centroid = &mut self.centroids[index];
                let n        = centroid.count as f32;

                for (c, e) in centroid.shape.iter_mut().zip(&embedding.shape) {
                    *c = (*c * n + e) / (n + 1.0);
                }

                centroid.pitch = match (centroid.pitch, embedding.pitch) {
                    (Some(a), Some(b)) => Some((a * n + b) / (n + 1.0)),
                    (None, b)          => b,
                    (a, None)          => a,
                };
                centroid.count += 1;
            }

            self.last = index;
        }

        speaker_name(index)
    }

    fn embed(&self, pcm: &[f32]) -> Option<Embedding> {
        if pcm.len() < MIN_SAMPLES {
            return None;
        }

        // Log band energies per frame, keeping only the louder (voiced) frames.
        let mut frames: Vec<(f32, Vec<f32>)> = Vec::new();
        let mut start = 0;

        while start + WINDOW <= pcm.len() {
            let slice = &pcm[start..start + WINDOW];
            let rms   = (slice.iter().map(|x| x * x).sum::<f32>() / WINDOW as f32).sqrt();

            let mut buffer: Vec<Complex<f32>> = (0..N_FFT)
                .map(|i| {
                    let v = if i < WINDOW { slice[i] * self.window[i] } else { 0.0 };
                    Complex::new(v, 0.0)
                })
                .collect();

            self.fft.process(&mut buffer);

            let power: Vec<f32> = buffer[..N_FFT / 2 + 1].iter().map(|c| c.norm_sqr()).collect();

            let bands: Vec<f32> = self
                .filters
                .iter()
                .map(|(first, weights)| {
                    let energy: f32 = weights.iter().enumerate().map(|(j, w)| w * power[first + j]).sum();
                    (energy + 1e-8).ln()
                })
                .collect();

            frames.push((rms, bands));
            start += HOP;
        }

        if frames.is_empty() {
            return None;
        }

        let mean_rms = frames.iter().map(|(r, _)| r).sum::<f32>() / frames.len() as f32;
        let voiced: Vec<&Vec<f32>> = frames
            .iter()
            .filter(|(rms, _)| *rms > mean_rms * 0.5)
            .map(|(_, bands)| bands)
            .collect();

        if voiced.is_empty() {
            return None;
        }

        // Remove each frame's overall level so loudness does not matter, then average.
        let mut shape = vec![0.0_f32; BANDS];

        for bands in &voiced {
            let level = bands.iter().sum::<f32>() / BANDS as f32;

            for (s, b) in shape.iter_mut().zip(bands.iter()) {
                *s += (b - level) / voiced.len() as f32;
            }
        }

        Some(Embedding { shape, pitch: mean_pitch(pcm) })
    }
}

/// Mean log-pitch over voiced frames (autocorrelation, 70 to 400 Hz).
fn mean_pitch(pcm: &[f32]) -> Option<f32> {
    let min_lag = SAMPLE_RATE as usize / 400;
    let max_lag = SAMPLE_RATE as usize / 70;

    let mut sum   = 0.0_f32;
    let mut count = 0_usize;
    let mut start = 0;

    while start + PITCH_WINDOW <= pcm.len() {
        let frame  = &pcm[start..start + PITCH_WINDOW];
        let energy: f32 = frame.iter().map(|x| x * x).sum();

        if energy > 1e-3 {
            let mut best_lag  = 0;
            let mut best_corr = 0.0_f32;

            for lag in min_lag..max_lag.min(PITCH_WINDOW - 1) {
                let corr: f32 = (0..PITCH_WINDOW - lag).map(|i| frame[i] * frame[i + lag]).sum();

                if corr > best_corr {
                    best_corr = corr;
                    best_lag  = lag;
                }
            }

            if best_lag > 0 && best_corr / energy > 0.35 {
                sum   += (SAMPLE_RATE as f32 / best_lag as f32).ln();
                count += 1;
            }
        }

        start += PITCH_HOP;
    }

    (count >= 3).then(|| sum / count as f32)
}

fn distance(embedding: &Embedding, centroid: &Centroid) -> f32 {
    let shape = (embedding
        .shape
        .iter()
        .zip(&centroid.shape)
        .map(|(a, b)| (a - b) * (a - b))
        .sum::<f32>()
        / BANDS as f32)
        .sqrt();

    let pitch = match (embedding.pitch, centroid.pitch) {
        (Some(a), Some(b)) => (a - b).abs(),
        _                  => 0.0,
    };

    // Pitch is the stronger cue, so it gets extra weight.
    shape * 0.25 + pitch * 1.5
}

fn band_filters() -> Vec<(usize, Vec<f32>)> {
    let hz_to_mel = |hz: f32| 2595.0 * (1.0 + hz / 700.0).log10();
    let mel_to_hz = |mel: f32| 700.0 * (10.0_f32.powf(mel / 2595.0) - 1.0);

    let low  = hz_to_mel(100.0);
    let high = hz_to_mel(7000.0);

    let to_bin = |hz: f32| hz * N_FFT as f32 / SAMPLE_RATE as f32;

    let edges: Vec<f32> = (0..BANDS + 2)
        .map(|i| to_bin(mel_to_hz(low + (high - low) * i as f32 / (BANDS + 1) as f32)))
        .collect();

    (0..BANDS)
        .map(|b| {
            let (left, center, right) = (edges[b], edges[b + 1], edges[b + 2]);
            let first = left.floor() as usize;
            let last  = (right.ceil() as usize).min(N_FFT / 2);

            let weights = (first..=last)
                .map(|bin| {
                    let x = bin as f32;

                    if x <= left || x >= right {
                        0.0
                    } else if x <= center {
                        (x - left) / (center - left).max(1e-6)
                    } else {
                        (right - x) / (right - center).max(1e-6)
                    }
                })
                .collect();

            (first, weights)
        })
        .collect()
}

fn speaker_name(index: usize) -> String {
    format!("Speaker {}", (b'A' + (index % 26) as u8) as char)
}
