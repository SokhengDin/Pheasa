//! Whisper speech-to-text running on candle, loaded straight from a Hugging
//! Face `transformers` checkpoint (config.json, tokenizer.json, model.safetensors).
//!
//! Decoding is greedy with no timestamps, which is what live subtitles need.

use std::path::Path;

use anyhow::{anyhow, Result};
use candle_core::{Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::whisper as m;
use tokenizers::Tokenizer;

pub struct WhisperStt {
    model            : m::model::Whisper,
    config           : m::Config,
    tokenizer        : Tokenizer,
    device           : Device,
    mel_filters      : Vec<f32>,
    suppress         : Tensor,
    multilingual     : bool,
    sot              : u32,
    eot              : u32,
    transcribe_token : u32,
    no_timestamps    : u32,
}

impl WhisperStt {
    pub fn load(dir: &Path, device: Device) -> Result<Self> {
        let config: m::Config = serde_json::from_slice(&std::fs::read(dir.join("config.json"))?)?;

        let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
            .map_err(|err| anyhow!("cannot read tokenizer.json: {err}"))?;

        let weights = dir.join("model.safetensors");
        let vb      = unsafe { VarBuilder::from_mmaped_safetensors(&[weights], m::DTYPE, &device)? };
        let model   = m::model::Whisper::load(&vb, config.clone())?;

        let token = |name: &str| -> Result<u32> {
            tokenizer
                .token_to_id(name)
                .ok_or_else(|| anyhow!("this tokenizer has no token {name}"))
        };

        let sot              = token("<|startoftranscript|>")?;
        let eot              = token("<|endoftext|>")?;
        let transcribe_token = token("<|transcribe|>")?;
        let no_timestamps    = token("<|notimestamps|>")?;
        let multilingual     = tokenizer.token_to_id("<|fr|>").is_some();

        // Block the model's own suppressed tokens, and every timestamp token
        // (ids after <|notimestamps|>), since we decode without timestamps.
        let mask: Vec<f32> = (0..config.vocab_size as u32)
            .map(|id| {
                if config.suppress_tokens.contains(&id) || id >= no_timestamps {
                    f32::NEG_INFINITY
                } else {
                    0.0
                }
            })
            .collect();
        let suppress = Tensor::new(mask.as_slice(), &device)?;

        let mel_filters = mel_filterbank(config.num_mel_bins, m::N_FFT, m::SAMPLE_RATE as f64);

        Ok(Self {
            model,
            config,
            tokenizer,
            device,
            mel_filters,
            suppress,
            multilingual,
            sot,
            eot,
            transcribe_token,
            no_timestamps,
        })
    }

    /// Picks the most likely spoken language from the encoder output. Language
    /// tokens sit between <|startoftranscript|> and <|translate|>.
    fn detect_language(&mut self, audio: &Tensor) -> Result<u32> {
        let input = Tensor::new(&[self.sot][..], &self.device)?.unsqueeze(0)?;
        let ys    = self.model.decoder.forward(&input, audio, true)?;
        let (_, seq_len, _) = ys.dims3()?;

        let logits = self
            .model
            .decoder
            .final_linear(&ys.i((..1, seq_len - 1..))?)?
            .i(0)?
            .i(0)?;

        let first = self.sot + 1;
        let end   = self.transcribe_token - 1;
        let best  = logits
            .narrow(0, first as usize, (end - first) as usize)?
            .argmax(0)?
            .to_scalar::<u32>()?;

        Ok(first + best)
    }

    /// Transcribes up to 30 s of 16 kHz mono audio. Pass a language code, or
    /// "auto" to detect the language of each phrase (multilingual models only).
    pub fn transcribe(&mut self, pcm: &[f32], lang: &str) -> Result<String> {
        let rms = (pcm.iter().map(|x| x * x).sum::<f32>() / pcm.len().max(1) as f32).sqrt();

        if rms < 1e-4 {
            return Ok(String::new());
        }

        // Whisper was trained on 30 s windows, so pad (or cut) to exactly that.
        let mut samples = pcm.to_vec();
        samples.truncate(m::N_SAMPLES);
        samples.resize(m::N_SAMPLES, 0.0);

        let n_mels  = self.config.num_mel_bins;
        let mel     = m::audio::pcm_to_mel(&self.config, &samples, &self.mel_filters);
        let mel_len = mel.len() / n_mels;
        let mel     = Tensor::from_vec(mel, (1, n_mels, mel_len), &self.device)?;
        let mel     = mel.narrow(2, 0, mel_len.min(m::N_FRAMES))?;

        let audio      = self.model.encoder.forward(&mel, true)?;
        let mut tokens = vec![self.sot];

        if self.multilingual {
            let lang_token = if lang == "auto" {
                self.detect_language(&audio)?
            } else {
                self
                    .tokenizer
                    .token_to_id(&format!("<|{lang}|>"))
                    .ok_or_else(|| anyhow!("Whisper does not know the language '{lang}'"))?
            };

            tokens.push(lang_token);
        }

        tokens.push(self.transcribe_token);
        tokens.push(self.no_timestamps);

        let prompt_len = tokens.len();
        let max_new    = (self.config.max_target_positions / 2).min(224);

        for step in 0..max_new {
            let input  = Tensor::new(tokens.as_slice(), &self.device)?.unsqueeze(0)?;
            let ys     = self.model.decoder.forward(&input, &audio, step == 0)?;
            let (_, seq_len, _) = ys.dims3()?;

            let logits = self
                .model
                .decoder
                .final_linear(&ys.i((..1, seq_len - 1..))?)?
                .i(0)?
                .i(0)?;
            let logits = logits.broadcast_add(&self.suppress)?;
            let next   = logits.argmax(0)?.to_scalar::<u32>()?;

            if next == self.eot {
                break;
            }

            tokens.push(next);

            // Whisper sometimes loops on a single token; cut it off.
            let n = tokens.len();
            if n > prompt_len + 6 && tokens[n - 4..].iter().all(|t| *t == next) {
                break;
            }
        }

        let text = self
            .tokenizer
            .decode(&tokens[prompt_len..], true)
            .map_err(|err| anyhow!("cannot decode tokens: {err}"))?;

        let text = text.trim().to_string();

        if text.chars().all(|c| !c.is_alphanumeric()) {
            return Ok(String::new());
        }

        Ok(text)
    }
}

/// Slaney-scale mel filterbank, identical to `librosa.filters.mel` (the one
/// Whisper uses), laid out as `[mel][fft_bin]`.
fn mel_filterbank(n_mels: usize, n_fft: usize, sample_rate: f64) -> Vec<f32> {
    const F_SP       : f64 = 200.0 / 3.0;
    const MIN_LOG_HZ : f64 = 1000.0;
    const MIN_LOG_MEL: f64 = MIN_LOG_HZ / F_SP;

    let log_step = (6.4_f64).ln() / 27.0;

    let hz_to_mel = |hz: f64| -> f64 {
        if hz >= MIN_LOG_HZ {
            MIN_LOG_MEL + (hz / MIN_LOG_HZ).ln() / log_step
        } else {
            hz / F_SP
        }
    };

    let mel_to_hz = |mel: f64| -> f64 {
        if mel >= MIN_LOG_MEL {
            MIN_LOG_HZ * (log_step * (mel - MIN_LOG_MEL)).exp()
        } else {
            F_SP * mel
        }
    };

    let n_freq  = n_fft / 2 + 1;
    let mel_min = hz_to_mel(0.0);
    let mel_max = hz_to_mel(sample_rate / 2.0);

    let mel_points: Vec<f64> = (0..n_mels + 2)
        .map(|i| mel_to_hz(mel_min + (mel_max - mel_min) * i as f64 / (n_mels + 1) as f64))
        .collect();

    let fft_freqs: Vec<f64> = (0..n_freq)
        .map(|k| k as f64 * sample_rate / n_fft as f64)
        .collect();

    let mut weights = vec![0.0_f32; n_mels * n_freq];

    for i in 0..n_mels {
        let lower_width = mel_points[i + 1] - mel_points[i];
        let upper_width = mel_points[i + 2] - mel_points[i + 1];
        let norm        = 2.0 / (mel_points[i + 2] - mel_points[i]);

        for (k, freq) in fft_freqs.iter().enumerate() {
            let lower = (freq - mel_points[i]) / lower_width;
            let upper = (mel_points[i + 2] - freq) / upper_width;

            weights[i * n_freq + k] = (lower.min(upper).max(0.0) * norm) as f32;
        }
    }

    weights
}
