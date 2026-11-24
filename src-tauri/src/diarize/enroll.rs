//! Records a few seconds from the microphone and saves the voice under a name,
//! so the app recognises that person in every later meeting.

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use crossbeam_channel::{unbounded, RecvTimeoutError};
use serde_json::json;

use super::voices::{unit, VoiceProfile, VoiceStore};
use crate::audio::capture::{CaptureHandle, CaptureRequest};
use crate::audio::{AudioChunk, Source, SAMPLE_RATE};
use crate::models::{self, Task};
use crate::runtime;
use crate::settings::Settings;

const MIN_SECONDS : u32   = 5;
const MAX_SECONDS : u32   = 30;
const WINDOW      : usize = SAMPLE_RATE as usize * 4;
const FRAME       : usize = SAMPLE_RATE as usize / 10;

/// Below this average level nothing was said (wrong or muted microphone).
const SILENT      : f32   = 0.003;

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    (samples.iter().map(|x| x * x).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Keeps the parts where the person is actually talking: 100 ms frames louder
/// than half the overall level.
fn voiced(samples: &[f32], overall: f32) -> Vec<f32> {
    samples
        .chunks(FRAME)
        .filter(|frame| rms(frame) > overall * 0.5)
        .flatten()
        .copied()
        .collect()
}

/// Blocking: records for `seconds`, then embeds the speech and saves the profile.
/// The speaker model must be chosen and downloaded, and the translator stopped
/// (it holds the microphone and the model).
pub fn enroll_from_mic(data_dir: &Path, settings: &Settings, name: &str, seconds: u32) -> Result<VoiceProfile> {
    let name = name.trim();

    if name.is_empty() {
        bail!("Give this voice a name first");
    }

    let model_id = settings
        .speaker_model
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Choose a speaker model in Settings first. It is what makes a voice recognisable"))?;

    let dir = models::model_dir(&data_dir.join("models"), Task::Speaker, &model_id);

    if !models::is_complete(&dir) {
        bail!("The speaker model {model_id} is not downloaded yet");
    }

    if !runtime::is_ready(data_dir) {
        bail!("Recognising voices needs the Python runtime. Set it up in Storage first");
    }

    runtime::ensure_loaded(data_dir)?;

    let result = record_and_embed(data_dir, settings, &model_id, &dir, name, seconds.clamp(MIN_SECONDS, MAX_SECONDS));

    // Nothing stays in memory once the voice is saved.
    runtime::release();

    result
}

fn record_and_embed(
    data_dir : &Path,
    settings : &Settings,
    model_id : &str,
    dir      : &Path,
    name     : &str,
    seconds  : u32,
) -> Result<VoiceProfile> {
    runtime::call(
        "load_embed",
        json!({ "model_dir": dir.to_string_lossy(), "device": settings.device.python_name() }),
        None,
    )?;

    let (tx, rx) = unbounded::<AudioChunk>();
    let capture  = CaptureHandle::start(
        vec![CaptureRequest { source: Source::Mic, device_key: settings.mic_device.clone() }],
        tx,
    )?;

    let mut samples = Vec::<f32>::new();
    let clock       = Instant::now();

    while clock.elapsed() < Duration::from_secs(seconds as u64) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(chunk) if chunk.source == Source::Mic => samples.extend_from_slice(&chunk.samples),
            Ok(_)                                    => {}
            Err(RecvTimeoutError::Timeout)           => {}
            Err(RecvTimeoutError::Disconnected)      => break,
        }
    }

    capture.stop();

    let overall = rms(&samples);

    if overall < SILENT {
        bail!("Nothing was heard. Check the microphone in Settings and speak while it records");
    }

    let speech = voiced(&samples, overall);

    if speech.len() < SAMPLE_RATE as usize * 3 {
        bail!("Less than three seconds of speech was heard. Try again and keep talking until the timer ends");
    }

    let mut sum   = Vec::<f32>::new();
    let mut count = 0_u32;

    for window in speech.chunks(WINDOW).filter(|w| w.len() >= SAMPLE_RATE as usize * 2) {
        let reply  = runtime::call("embed", json!({}), Some(window))?;
        let vector: Vec<f32> = reply["vector"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_f64()).map(|v| v as f32).collect())
            .unwrap_or_default();

        if vector.is_empty() {
            continue;
        }

        if sum.is_empty() {
            sum = vec![0.0; vector.len()];
        }

        if vector.len() != sum.len() {
            continue;
        }

        for (s, v) in sum.iter_mut().zip(&unit(vector)) {
            *s += v;
        }

        count += 1;
    }

    if count == 0 {
        bail!("The speaker model returned nothing for this recording");
    }

    VoiceStore::load(data_dir).upsert(name, model_id, sum, count)
}
