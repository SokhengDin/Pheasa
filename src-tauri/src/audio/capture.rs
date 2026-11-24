//! Microphone and system-audio capture.
//!
//! System audio ("what the other people on the call say") is captured as a
//! loopback of the default output device on Windows and macOS, and from a
//! "monitor" source on Linux (PulseAudio / PipeWire). Any device can also be
//! chosen by hand in Settings, for example a virtual cable on macOS.
//!
//! cpal streams are not `Send` on every platform, so they are created and kept
//! alive on one dedicated thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::Sender;

use super::devices::find_device;
use super::resample::Resampler;
use super::{AudioChunk, Source, SAMPLE_RATE};

pub struct CaptureRequest {
    pub source     : Source,
    pub device_key : Option<String>,
}

pub struct CaptureHandle {
    stop   : Arc<AtomicBool>,
    thread : Option<JoinHandle<()>>,
}

impl CaptureHandle {
    pub fn start(requests: Vec<CaptureRequest>, tx: Sender<AudioChunk>) -> Result<Self> {
        let stop                 = Arc::new(AtomicBool::new(false));
        let stop_for_thread      = stop.clone();
        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);

        let thread = thread::Builder::new()
            .name("audio-capture".into())
            .spawn(move || {
                let mut streams = Vec::new();

                for request in &requests {
                    match open_stream(request, tx.clone()) {
                        Ok(stream) => streams.push(stream),
                        Err(err)   => {
                            let _ = ready_tx.send(Err(format!("{err:#}")));
                            return;
                        }
                    }
                }

                for stream in &streams {
                    if let Err(err) = stream.play() {
                        let _ = ready_tx.send(Err(format!("cannot start audio stream: {err}")));
                        return;
                    }
                }

                let _ = ready_tx.send(Ok(()));

                while !stop_for_thread.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(100));
                }

                drop(streams);
            })?;

        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(Self { stop, thread: Some(thread) }),
            Ok(Err(message)) => {
                let _ = thread.join();
                Err(anyhow!(message))
            }
            Err(_) => {
                stop.store(true, Ordering::Relaxed);
                Err(anyhow!("audio capture did not start in time"))
            }
        }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);

        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn open_stream(request: &CaptureRequest, tx: Sender<AudioChunk>) -> Result<cpal::Stream> {
    let device    = pick_device(request)?;
    let label     = device.to_string();
    let supported = pick_config(&device, request.source)
        .map_err(|err| anyhow!("no usable audio format on {label}: {err}"))?;

    let channels = supported.channels() as usize;
    let rate: u32 = supported.sample_rate();
    let format   = supported.sample_format();
    let config: cpal::StreamConfig = supported.config();

    let resampler = Resampler::new(rate, SAMPLE_RATE);
    let source    = request.source;

    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(&device, config, channels, resampler, source, tx),
        cpal::SampleFormat::I16 => build::<i16>(&device, config, channels, resampler, source, tx),
        cpal::SampleFormat::U16 => build::<u16>(&device, config, channels, resampler, source, tx),
        cpal::SampleFormat::I32 => build::<i32>(&device, config, channels, resampler, source, tx),
        other => bail!("unsupported sample format {other:?} on {label}"),
    };

    stream.map_err(|err| anyhow!("cannot open {label}: {err}"))
}

fn build<T>(
    device    : &cpal::Device,
    config    : cpal::StreamConfig,
    channels  : usize,
    mut resampler : Resampler,
    source    : Source,
    tx        : Sender<AudioChunk>,
) -> Result<cpal::Stream, cpal::Error>
where
    T   : cpal::SizedSample + Send + 'static,
    f32 : cpal::FromSample<T>,
{
    let mut mono = Vec::<f32>::new();

    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            mono.clear();

            for frame in data.chunks(channels.max(1)) {
                let mut sum = 0.0_f32;

                for sample in frame {
                    sum += cpal::Sample::to_sample::<f32>(*sample);
                }

                mono.push(sum / frame.len() as f32);
            }

            let mut out = Vec::with_capacity(mono.len() / 2 + 8);
            resampler.process(&mono, &mut out);

            if !out.is_empty() {
                let _ = tx.send(AudioChunk { source, samples: out });
            }
        },
        move |err: cpal::Error| log::error!("audio stream error: {err}"),
        None,
    )
}

fn pick_device(request: &CaptureRequest) -> Result<cpal::Device> {
    if let Some(key) = &request.device_key {
        return find_device(key).ok_or_else(|| anyhow!("audio device not found: {key}"));
    }

    match request.source {
        Source::Mic => cpal::default_host()
            .default_input_device()
            .ok_or_else(|| anyhow!("no default microphone found")),
        Source::System => system_default(),
    }
}

#[cfg(not(target_os = "linux"))]
fn system_default() -> Result<cpal::Device> {
    cpal::default_host()
        .default_output_device()
        .ok_or_else(|| anyhow!("no default output device to capture"))
}

#[cfg(target_os = "linux")]
fn system_default() -> Result<cpal::Device> {
    for host_id in cpal::available_hosts() {
        let Ok(host)    = cpal::host_from_id(host_id) else { continue };
        let Ok(devices) = host.devices() else { continue };

        for device in devices {
            if device.supports_input() && device.to_string().to_lowercase().contains("monitor") {
                return Ok(device);
            }
        }
    }

    bail!(
        "no monitor source found. Pick one in Settings; with PulseAudio or PipeWire it is named \"Monitor of ...\""
    )
}

fn pick_config(device: &cpal::Device, source: Source) -> Result<cpal::SupportedStreamConfig> {
    // Loopback of an output device is described by its output format.
    if source == Source::System && device.supports_output() {
        if let Ok(config) = device.default_output_config() {
            return Ok(config);
        }
    }

    device
        .default_input_config()
        .map_err(|err| anyhow!("{err}"))
}
