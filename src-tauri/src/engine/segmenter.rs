//! Cuts a continuous 16 kHz stream into speech segments, with periodic partial
//! snapshots for live subtitles.
//!
//! Two ways to decide whether a frame is speech: a neural gate (Silero VAD,
//! through the Python runtime) or an adaptive energy threshold. Either way a
//! short pre-roll keeps word onsets from being clipped, and a pause closes the
//! segment.

use std::collections::VecDeque;

const MAX_SAMPLES  : usize = 16_000 * 15;    // force a cut after 15 s
const SOFT_SAMPLES : usize = 16_000 * 8;     // past 8 s, cut at the next short pause
const PARTIAL_STEP : usize = 16_000 * 3 / 2; // live preview every 1.5 s of new audio...
const LONG_STEP    : usize = 16_000 * 3;     // ...or every 3 s once the segment is long
const MIN_FLOOR    : f32   = 0.006;
const NEURAL_LEVEL : f32   = 0.5;
/// Frames sent to the neural gate per call. Each call crosses into Python, so
/// batching ~256 ms at a time keeps that overhead low.
const NEURAL_BATCH : usize = 8;

/// Every preview re-transcribes the whole segment, so previews of long
/// segments come less often to keep their cost down.
fn partial_step(len: usize) -> usize {
    if len >= SOFT_SAMPLES { LONG_STEP } else { PARTIAL_STEP }
}

pub enum SegEvent {
    Partial(Vec<f32>),
    Final(Vec<f32>),
}

/// Frame-level speech probabilities. `samples` is a multiple of 512 samples.
pub trait SpeechGate: Send {
    fn probabilities(&mut self, samples: &[f32]) -> Option<Vec<f32>>;
}

struct Tuning {
    frame      : usize,
    preroll    : usize,
    onset      : usize,
    hangover   : usize,
    min_voiced : usize,
}

const ENERGY: Tuning = Tuning { frame: 320, preroll: 10, onset: 4, hangover: 30, min_voiced: 12 };
const NEURAL: Tuning = Tuning { frame: 512, preroll: 8,  onset: 3, hangover: 20, min_voiced: 8  };

pub struct Segmenter {
    gate         : Option<Box<dyn SpeechGate>>,
    tuning       : &'static Tuning,
    carry        : Vec<f32>,
    preroll      : VecDeque<Vec<f32>>,
    buf          : Vec<f32>,
    in_speech    : bool,
    onset        : usize,
    silence      : usize,
    voiced       : usize,
    noise_floor  : f32,
    last_partial : usize,
}

impl Segmenter {
    pub fn new(gate: Option<Box<dyn SpeechGate>>) -> Self {
        let tuning = if gate.is_some() { &NEURAL } else { &ENERGY };

        Self {
            gate,
            tuning,
            carry        : Vec::new(),
            preroll      : VecDeque::new(),
            buf          : Vec::new(),
            in_speech    : false,
            onset        : 0,
            silence      : 0,
            voiced       : 0,
            noise_floor  : 0.005,
            last_partial : 0,
        }
    }

    pub fn push(&mut self, samples: &[f32]) -> Vec<SegEvent> {
        self.carry.extend_from_slice(samples);

        let frame = self.tuning.frame;
        let count = self.carry.len() / frame;
        let batch = if self.gate.is_some() { NEURAL_BATCH } else { 1 };

        if count < batch {
            return Vec::new();
        }

        let batch: Vec<f32> = self.carry.drain(..count * frame).collect();

        // Neural decision for the whole batch; if it fails, fall back to energy.
        let probs = self
            .gate
            .as_mut()
            .and_then(|gate| gate.probabilities(&batch))
            .filter(|p| p.len() == count);

        let mut events = Vec::new();

        for (i, chunk) in batch.chunks(frame).enumerate() {
            let loud = match &probs {
                Some(p) => p[i] > NEURAL_LEVEL,
                None    => self.energy_loud(chunk),
            };

            self.on_frame(chunk.to_vec(), loud, &mut events);
        }

        events
    }

    fn energy_loud(&mut self, frame: &[f32]) -> bool {
        let rms       = (frame.iter().map(|x| x * x).sum::<f32>() / frame.len() as f32).sqrt();
        let threshold = (self.noise_floor * 3.0).max(MIN_FLOOR);
        let loud      = rms > threshold;

        if !loud && !self.in_speech {
            self.noise_floor = (0.95 * self.noise_floor + 0.05 * rms).clamp(1e-4, 0.05);
        }

        loud
    }

    fn on_frame(&mut self, frame: Vec<f32>, loud: bool, events: &mut Vec<SegEvent>) {
        let t = self.tuning;

        if !self.in_speech {
            self.preroll.push_back(frame);

            while self.preroll.len() > t.preroll + t.onset {
                self.preroll.pop_front();
            }

            if loud {
                self.onset += 1;

                if self.onset >= t.onset {
                    self.in_speech    = true;
                    self.silence      = 0;
                    self.voiced       = self.onset;
                    self.last_partial = 0;
                    self.buf.clear();

                    for f in self.preroll.drain(..) {
                        self.buf.extend(f);
                    }
                }
            } else {
                self.onset = 0;
            }

            return;
        }

        self.buf.extend_from_slice(&frame);

        if loud {
            self.silence = 0;
            self.voiced += 1;
        } else {
            self.silence += 1;
        }

        // A long segment is cut at a short pause rather than waiting for a full
        // one, so it rarely reaches the hard limit and gets split mid-word.
        let pause = self.silence >= t.hangover
            || (self.buf.len() >= SOFT_SAMPLES && self.silence >= t.hangover / 3);

        if pause || self.buf.len() >= MAX_SAMPLES {
            if self.voiced >= t.min_voiced {
                events.push(SegEvent::Final(std::mem::take(&mut self.buf)));
            } else {
                self.buf.clear();
            }

            self.in_speech    = false;
            self.onset        = 0;
            self.silence      = 0;
            self.voiced       = 0;
            self.last_partial = 0;
            self.preroll.clear();
        } else if self.buf.len() - self.last_partial >= partial_step(self.buf.len()) {
            self.last_partial = self.buf.len();
            events.push(SegEvent::Partial(self.buf.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(ms: usize) -> Vec<f32> {
        (0..16 * ms).map(|i| 0.2 * (i as f32 * 0.3).sin()).collect()
    }

    fn quiet(ms: usize) -> Vec<f32> {
        vec![0.0; 16 * ms]
    }

    fn finals(seg: &mut Segmenter, audio: &[f32]) -> Vec<usize> {
        audio
            .chunks(160)
            .flat_map(|c| seg.push(c))
            .filter_map(|e| match e { SegEvent::Final(pcm) => Some(pcm.len()), _ => None })
            .collect()
    }

    #[test]
    fn short_pause_cuts_long_segment() {
        let mut seg   = Segmenter::new(None);
        let mut audio = tone(9_000);
        audio.extend(quiet(300));

        let cuts = finals(&mut seg, &audio);
        assert_eq!(cuts.len(), 1);
        assert!(cuts[0] < MAX_SAMPLES);
    }

    #[test]
    fn short_pause_keeps_short_segment_open() {
        let mut seg   = Segmenter::new(None);
        let mut audio = tone(2_000);
        audio.extend(quiet(300));
        audio.extend(tone(2_000));

        assert!(finals(&mut seg, &audio).is_empty());
    }
}
