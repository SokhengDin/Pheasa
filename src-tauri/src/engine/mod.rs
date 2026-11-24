//! The live pipeline: capture, level metering, voice-activity segmentation,
//! speech-to-text, speaker label, translation, optional speech output, and
//! events to the UI.

mod guard;
mod segmenter;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use candle_core::Device;
use crossbeam_channel::{unbounded, Receiver, RecvTimeoutError, Sender};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::audio::capture::{CaptureHandle, CaptureRequest};
use crate::audio::{AudioChunk, Source};
use crate::compute;
use crate::diarize::embed::EmbedLabeler;
use crate::diarize::Labeler;
use crate::models::{self, Backend, Task};
use crate::runtime;
use crate::settings::{MtBackend, Settings};
use crate::stt::{PyStt, Transcriber, WhisperStt};
use crate::translate::cloud::CloudTranslator;
use crate::translate::marian::MarianTranslator;
use crate::translate::python::PyTranslator;
use crate::translate::{ChainTranslator, GlossaryTranslator, Passthrough, Translator};

use guard::{is_junk, EchoFilter, EchoGate};
use segmenter::{SegEvent, Segmenter, SpeechGate};

/// Messages the app sends to a running translator.
pub enum Control {
    /// Save the voice behind an unknown speaker label under a name.
    Remember {
        label : String,
        name  : String,
        reply : Sender<Result<String, String>>,
    },
    /// Voices were added, renamed or deleted: read them again.
    ReloadVoices,
}

pub struct EngineHandle {
    stop    : Arc<AtomicBool>,
    threads : Vec<JoinHandle<()>>,
    capture : Option<CaptureHandle>,
    control : Option<Sender<Control>>,
}

impl EngineHandle {
    /// The channel to a running translator (none for the level monitor).
    pub fn control(&self) -> Option<Sender<Control>> {
        self.control.clone()
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);

        if let Some(capture) = self.capture.take() {
            capture.stop();
        }

        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }

        // Native models are dropped with their threads. The Python ones live in the
        // embedded interpreter, so free them here: nothing stays in memory when idle.
        runtime::release();
    }
}

#[derive(Debug, Clone, Serialize)]
struct StatusEvent {
    state   : String,
    message : String,
    device  : String,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptEvent {
    id          : u64,
    source      : String,
    speaker     : String,
    is_final    : bool,
    text        : String,
    translation : Option<String>,
    known       : bool,
    started_ms  : u64,
    ended_ms    : u64,
}

#[derive(Debug, Clone, Serialize)]
struct LevelEvent {
    source : String,
    rms    : f32,
    peak   : f32,
}

/// Speed of the pipeline: seconds of work per second of audio. Under 1.0 it
/// keeps up with live speech.
#[derive(Debug, Clone, Serialize)]
struct PerfEvent {
    rtf      : f32,
    stt_ms   : u64,
    mt_ms    : u64,
    audio_ms : u64,
}

#[derive(Debug, Clone, Serialize)]
struct TtsEvent {
    wav     : String,
    seconds : f32,
}

pub fn emit_status(app: &AppHandle, state: &str, message: &str, device: &str) {
    let _ = app.emit(
        "engine-status",
        StatusEvent {
            state   : state.to_string(),
            message : message.to_string(),
            device  : device.to_string(),
        },
    );
}

fn capture_requests(settings: &Settings) -> Result<Vec<CaptureRequest>> {
    let mut requests = Vec::new();

    if settings.capture_system {
        requests.push(CaptureRequest {
            source     : Source::System,
            device_key : settings.system_device.clone(),
        });
    }

    if settings.capture_mic {
        requests.push(CaptureRequest {
            source     : Source::Mic,
            device_key : settings.mic_device.clone(),
        });
    }

    if requests.is_empty() {
        bail!("Turn on the microphone, system audio, or both in Settings");
    }

    Ok(requests)
}

/// Returns the engine of an installed model, or an error that says what to do.
fn backend_of(models_dir: &Path, task: Task, id: &str) -> Result<(PathBuf, Backend)> {
    let dir = models::model_dir(models_dir, task, id);

    if !models::is_complete(&dir) {
        bail!("The model {id} is not downloaded yet");
    }

    let backend = models::read_meta(&dir).map(|m| m.backend).unwrap_or_default();

    Ok((dir, backend))
}

fn require_python(data_dir: &Path, what: &str) -> Result<()> {
    if !runtime::is_ready(data_dir) {
        bail!("{what} needs the Python runtime. Set it up in Storage first");
    }

    runtime::ensure_loaded(data_dir)
}

/// Like `require_python`, and for an MLX model also checks the MLX packages.
fn require_engine(data_dir: &Path, backend: Backend, what: &str) -> Result<()> {
    require_python(data_dir, what)?;

    if backend == Backend::Mlx && !runtime::mlx_ready(data_dir) {
        bail!("{what} runs on MLX (Apple GPU). Open Storage and press Add MLX");
    }

    Ok(())
}

struct PyVad {
    stream: String,
}

impl SpeechGate for PyVad {
    fn probabilities(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        let reply = runtime::call("vad", json!({ "stream": self.stream }), Some(samples)).ok()?;

        reply["probs"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_f64()).map(|v| v as f32).collect())
    }
}

/// Loads the models, opens the audio devices and starts the worker threads.
/// Blocking: call it from `spawn_blocking`.
pub fn start(app: AppHandle, data_dir: PathBuf, settings: Settings) -> Result<EngineHandle> {
    emit_status(&app, "loading", "Loading models", "");

    let models_dir = data_dir.join("models");
    let py_device  = settings.device.python_name();

    let stt_id = settings
        .stt_model
        .clone()
        .ok_or_else(|| anyhow!("Choose a speech-to-text model in Models first"))?;

    let (stt_dir, stt_backend) = backend_of(&models_dir, Task::Stt, &stt_id)?;

    if stt_backend.needs_python() {
        require_engine(&data_dir, stt_backend, "This speech-to-text model")?;
    }

    // The built-in engine needs a candle device; a Python-only setup does not.
    let (device, mut device_name) = match compute::select(settings.device) {
        Ok(found) => found,
        Err(err) if stt_backend.needs_python() => {
            log::warn!("candle device unavailable ({err:#}); using the Python runtime only");
            (Device::Cpu, "Python runtime".to_string())
        }
        Err(err) => return Err(err),
    };

    let stt: Box<dyn Transcriber> = match stt_backend {
        Backend::Native => Box::new(WhisperStt::load(&stt_dir, device.clone())?),
        Backend::Python | Backend::Mlx => {
            let stt = PyStt::load(&stt_dir, py_device, stt_backend.engine_name())?;

            device_name = if stt_backend == Backend::Mlx {
                if py_device == "cpu" { "CPU (MLX)".to_string() } else { "Apple GPU (MLX)".to_string() }
            } else {
                format!("{} (Python)", py_device.to_uppercase())
            };

            Box::new(stt)
        }
    };

    let translator = GlossaryTranslator::wrap(
        build_translator(&settings, &data_dir, &models_dir, &device)?,
        &settings.glossary,
    );

    // Neural voice-activity detection, only when the runtime is there.
    let neural_vad = settings.neural_vad
        && runtime::is_ready(&data_dir)
        && runtime::ensure_loaded(&data_dir).is_ok()
        && runtime::call("load_vad", json!({}), None).is_ok();

    // Speaker separation by voice, when a speaker model is chosen.
    let mut embed_labeler = None;

    if settings.separate_remote_speakers {
        if let Some(id) = settings.speaker_model.clone() {
            let (dir, _) = backend_of(&models_dir, Task::Speaker, &id)?;
            require_python(&data_dir, "The speaker model")?;
            embed_labeler = Some(EmbedLabeler::load(&dir, py_device, settings.speaker_threshold, &id, &data_dir)?);
        }
    }

    let started    = Instant::now();
    let mute_until = Arc::new(AtomicU64::new(0));

    // Speech output for the translation.
    let mut tts_tx: Option<Sender<String>> = None;
    let mut threads: Vec<JoinHandle<()>>   = Vec::new();
    let mut tts_thread: Option<JoinHandle<()>> = None;

    if settings.speak_translation {
        if let Some(id) = settings.tts_model.clone() {
            let (dir, tts_backend) = backend_of(&models_dir, Task::Tts, &id)?;
            require_engine(&data_dir, tts_backend, "Speaking the translation")?;
            runtime::call(
                "load_tts",
                json!({
                    "model_dir" : dir.to_string_lossy(),
                    "device"    : py_device,
                    "engine"    : tts_backend.engine_name(),
                    "lang"      : settings.target_lang,
                }),
                None,
            )?;

            let (tx, rx) = unbounded::<String>();
            tts_tx       = Some(tx);

            tts_thread = Some(thread::Builder::new().name("translator-tts".into()).spawn({
                let app        = app.clone();
                let mute_until = mute_until.clone();

                move || tts_loop(app, rx, started, mute_until)
            })?);
        }
    }

    let requests = capture_requests(&settings)?;

    let (tx, rx)           = unbounded::<AudioChunk>();
    let (work_tx, work_rx) = unbounded::<AudioChunk>();
    let (control_tx, control_rx) = unbounded::<Control>();
    let capture            = CaptureHandle::start(requests, tx)?;

    // The microphone only hears the remote side when both are captured.
    let echo_guard = settings.echo_guard && settings.capture_mic && settings.capture_system;
    let stop               = Arc::new(AtomicBool::new(false));

    threads.push(thread::Builder::new().name("translator-levels".into()).spawn({
        let app        = app.clone();
        let stop       = stop.clone();
        let mute_until = mute_until.clone();

        move || dispatch_loop(app, rx, Some(work_tx), stop, started, mute_until, echo_guard)
    })?);

    threads.push(thread::Builder::new().name("translator-engine".into()).spawn({
        let app      = app.clone();
        let stop     = stop.clone();
        let settings = settings.clone();

        move || {
            run_loop(
                app,
                work_rx,
                control_rx,
                stop,
                stt,
                translator,
                settings,
                neural_vad,
                embed_labeler,
                tts_tx,
                started,
                echo_guard,
            )
        }
    })?);

    // The speech thread ends once the worker drops its sender, so it is joined last.
    threads.extend(tts_thread);

    let label = if neural_vad { "Listening (neural VAD)" } else { "Listening" };
    emit_status(&app, "running", label, &device_name);

    Ok(EngineHandle { stop, threads, capture: Some(capture), control: Some(control_tx) })
}

/// Opens the audio devices only to show input levels (the test in setup and
/// Settings). Nothing is transcribed.
pub fn start_monitor(app: AppHandle, settings: Settings) -> Result<EngineHandle> {
    let requests = capture_requests(&settings)?;

    let (tx, rx) = unbounded::<AudioChunk>();
    let capture  = CaptureHandle::start(requests, tx)?;
    let stop     = Arc::new(AtomicBool::new(false));

    let thread = thread::Builder::new().name("translator-monitor".into()).spawn({
        let stop = stop.clone();

        move || dispatch_loop(app, rx, None, stop, Instant::now(), Arc::new(AtomicU64::new(0)), false)
    })?;

    Ok(EngineHandle { stop, threads: vec![thread], capture: Some(capture), control: None })
}

/// Measures every chunk for the level meters, drops audio while the app is
/// speaking its own translation (so it does not hear itself), silences the
/// microphone while it is only picking up the speakers (`echo_guard`), and
/// forwards the rest to the worker.
fn dispatch_loop(
    app        : AppHandle,
    rx         : Receiver<AudioChunk>,
    forward    : Option<Sender<AudioChunk>>,
    stop       : Arc<AtomicBool>,
    started    : Instant,
    mute_until : Arc<AtomicU64>,
    echo_guard : bool,
) {
    let mut last_emit: HashMap<Source, Instant> = HashMap::new();
    let mut peak_rms : HashMap<Source, (f32, f32)> = HashMap::new();
    let mut gate                                   = echo_guard.then(EchoGate::new);

    while !stop.load(Ordering::Relaxed) {
        let mut chunk = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(chunk)                           => chunk,
            Err(RecvTimeoutError::Timeout)      => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };

        let source    = chunk.source;
        let mut level = 0.0_f32;

        if !chunk.samples.is_empty() {
            let rms  = (chunk.samples.iter().map(|x| x * x).sum::<f32>() / chunk.samples.len() as f32).sqrt();
            level    = rms;
            let peak = chunk.samples.iter().fold(0.0_f32, |m, x| m.max(x.abs()));

            let slot = peak_rms.entry(source).or_insert((0.0, 0.0));
            slot.0   = slot.0.max(rms);
            slot.1   = slot.1.max(peak);

            let due = last_emit
                .get(&source)
                .map_or(true, |t| t.elapsed() > Duration::from_millis(60));

            if due {
                let (rms, peak) = peak_rms.remove(&source).unwrap_or((0.0, 0.0));

                let _ = app.emit(
                    "audio-level",
                    LevelEvent { source: source.as_str().to_string(), rms, peak },
                );

                last_emit.insert(source, Instant::now());
            }
        }

        let now_ms = started.elapsed().as_millis() as u64;

        if let Some(gate) = gate.as_mut() {
            if gate.is_bleed(source, level, now_ms) {
                chunk.samples.iter_mut().for_each(|s| *s = 0.0);
            }
        }

        let muted = now_ms < mute_until.load(Ordering::Relaxed);

        if muted {
            continue;
        }

        if let Some(tx) = &forward {
            if tx.send(chunk).is_err() {
                break;
            }
        }
    }
}

fn tts_loop(app: AppHandle, rx: Receiver<String>, started: Instant, mute_until: Arc<AtomicU64>) {
    for text in rx {
        match runtime::call("speak", json!({ "text": text }), None) {
            Ok(reply) => {
                let seconds = reply["seconds"].as_f64().unwrap_or(0.0) as f32;
                let wav     = reply["wav"].as_str().unwrap_or("").to_string();

                // Ignore the microphone and loopback until the voice has finished.
                let until = started.elapsed().as_millis() as u64 + (seconds * 1000.0) as u64 + 500;
                mute_until.store(until, Ordering::Relaxed);

                let _ = app.emit("tts-audio", TtsEvent { wav, seconds });
            }
            Err(err) => log::error!("speech output failed: {err:#}"),
        }
    }
}

fn local_translator(
    data_dir   : &Path,
    models_dir : &Path,
    device     : &Device,
    settings   : &Settings,
    id         : &str,
    slot       : &str,
    src        : &str,
    tgt        : &str,
) -> Result<Box<dyn Translator>> {
    let (dir, backend) = backend_of(models_dir, Task::Translation, id)?;

    match backend {
        Backend::Native => {
            if let Some(meta) = models::read_meta(&dir) {
                let found  = (meta.src_lang.clone(), meta.tgt_lang.clone());
                let wanted = (Some(src.to_string()), Some(tgt.to_string()));

                if found != wanted {
                    bail!(
                        "{id} translates {} to {}, but this step needs {src} to {tgt}",
                        meta.src_lang.unwrap_or_default(),
                        meta.tgt_lang.unwrap_or_default(),
                    );
                }
            }

            Ok(Box::new(MarianTranslator::load(&dir, device.clone())?))
        }
        Backend::Python | Backend::Mlx => {
            require_engine(data_dir, backend, "This translation model")?;

            Ok(Box::new(PyTranslator::load(
                &dir,
                settings.device.python_name(),
                backend.engine_name(),
                slot,
                src,
                tgt,
            )?))
        }
    }
}

fn build_translator(
    settings   : &Settings,
    data_dir   : &Path,
    models_dir : &Path,
    device     : &Device,
) -> Result<Box<dyn Translator>> {
    let (src, tgt) = (settings.source_lang.as_str(), settings.target_lang.as_str());

    if src == tgt {
        return Ok(Box::new(Passthrough));
    }

    match settings.mt_backend {
        MtBackend::Cloud => Ok(Box::new(CloudTranslator::new(settings.cloud.clone(), src, tgt)?)),
        MtBackend::Local => {
            if src == "auto" {
                bail!("Automatic language detection works with the cloud backend. Pick a source language for local translation");
            }

            let first = settings
                .mt_model
                .clone()
                .ok_or_else(|| anyhow!("Choose a translation model in Models, or switch to the cloud backend"))?;

            // A second model means translating through English: src -> en -> tgt.
            match settings.mt_model_2.clone() {
                Some(second) if src != "en" && tgt != "en" => {
                    let a = local_translator(data_dir, models_dir, device, settings, &first, "mt", src, "en")?;
                    let b = local_translator(data_dir, models_dir, device, settings, &second, "mt2", "en", tgt)?;

                    Ok(Box::new(ChainTranslator::new(a, b)))
                }
                _ => local_translator(data_dir, models_dir, device, settings, &first, "mt", src, tgt),
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_loop(
    app            : AppHandle,
    rx             : Receiver<AudioChunk>,
    control        : Receiver<Control>,
    stop           : Arc<AtomicBool>,
    mut stt        : Box<dyn Transcriber>,
    mut translator : Box<dyn Translator>,
    settings       : Settings,
    neural_vad     : bool,
    embed_labeler  : Option<EmbedLabeler>,
    tts            : Option<Sender<String>>,
    started        : Instant,
    echo_guard     : bool,
) {
    let mut segmenters: HashMap<Source, Segmenter> = HashMap::new();
    let mut open: HashMap<Source, (u64, u64)>      = HashMap::new();
    let mut next_id = 1_u64;
    let mut labeler = Labeler::new(settings.separate_remote_speakers, settings.speaker_threshold)
        .with_neural(embed_labeler);
    let lang        = settings.source_lang.clone();
    let mut echoes  = EchoFilter::new();

    if settings.separate_remote_speakers && !labeler.has_voice_model() {
        emit_status(
            &app,
            "running",
            "Basic speaker guess: choose a speaker model in Settings so voices can be recognised and named",
            "",
        );
    }

    while !stop.load(Ordering::Relaxed) {
        while let Ok(command) = control.try_recv() {
            match command {
                Control::Remember { label, name, reply } => {
                    let _ = reply.send(labeler.remember(&label, &name).map_err(|err| format!("{err:#}")));
                }
                Control::ReloadVoices => labeler.reload_voices(),
            }
        }

        let chunk = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(chunk)                           => chunk,
            Err(RecvTimeoutError::Timeout)      => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };

        let source = chunk.source;
        let events = segmenters
            .entry(source)
            .or_insert_with(|| {
                let gate: Option<Box<dyn SpeechGate>> = neural_vad
                    .then(|| Box::new(PyVad { stream: source.as_str().to_string() }) as Box<dyn SpeechGate>);

                Segmenter::new(gate)
            })
            .push(&chunk.samples);

        for event in events {
            let (pcm, is_final) = match event {
                SegEvent::Partial(pcm) => (pcm, false),
                SegEvent::Final(pcm)   => (pcm, true),
            };

            // If transcription is falling behind, drop live previews, never finals.
            if !is_final && rx.len() > 6 {
                continue;
            }

            let (id, started_ms) = *open.entry(source).or_insert_with(|| {
                let id = next_id;
                next_id += 1;
                (id, started.elapsed().as_millis() as u64)
            });

            let stt_clock = Instant::now();

            let text = match stt.transcribe(&pcm, &lang) {
                Ok(text) => text,
                Err(err) => {
                    log::error!("transcription failed: {err:#}");
                    emit_status(&app, "running", &format!("Transcription error: {err}"), "");
                    continue;
                }
            };

            let stt_ms   = stt_clock.elapsed().as_millis() as u64;
            let audio_ms = (pcm.len() as u64 * 1000) / crate::audio::SAMPLE_RATE as u64;

            // Nothing was said, or the model made something up.
            if text.is_empty() || is_junk(&text, audio_ms) {
                if is_final {
                    if open.remove(&source).is_some() {
                        let _ = app.emit("transcript-drop", id);
                    }
                }
                continue;
            }

            let now_ms = started.elapsed().as_millis() as u64;

            // The microphone repeating what the speakers just played.
            if echo_guard && is_final {
                match source {
                    Source::System => echoes.note_remote(&text, now_ms),
                    Source::Mic    => {
                        if echoes.is_echo(&text, started_ms, now_ms) {
                            open.remove(&source);
                            let _ = app.emit("transcript-drop", id);
                            continue;
                        }
                    }
                }
            }

            if echo_guard && !is_final && source == Source::Mic && echoes.is_echo(&text, started_ms, now_ms) {
                continue;
            }

            let who      = labeler.label(source, &pcm, is_final);
            let mt_clock = Instant::now();

            let translation = if is_final {
                match translator.translate(&text) {
                    Ok(t)    => Some(t),
                    Err(err) => {
                        log::error!("translation failed: {err:#}");
                        emit_status(&app, "running", &format!("Translation error: {err}"), "");
                        None
                    }
                }
            } else {
                None
            };

            let mt_ms = mt_clock.elapsed().as_millis() as u64;

            if is_final {
                let _ = app.emit(
                    "engine-perf",
                    PerfEvent {
                        rtf: (stt_ms + mt_ms) as f32 / audio_ms.max(1) as f32,
                        stt_ms,
                        mt_ms,
                        audio_ms,
                    },
                );

                // Read the translation of what other people said out loud.
                if source == Source::System {
                    if let (Some(tx), Some(spoken)) = (&tts, translation.as_ref()) {
                        let _ = tx.send(spoken.clone());
                    }
                }
            }

            let _ = app.emit(
                "transcript",
                TranscriptEvent {
                    id,
                    source : source.as_str().to_string(),
                    speaker: who.name,
                    is_final,
                    text,
                    translation,
                    known  : who.known,
                    started_ms,
                    ended_ms : started.elapsed().as_millis() as u64,
                },
            );

            if is_final {
                open.remove(&source);
            }
        }
    }

    emit_status(&app, "stopped", "Stopped", "");
}
