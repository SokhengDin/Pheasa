pub mod capture;
pub mod devices;
pub mod resample;

use serde::Serialize;

/// Everything downstream of capture works on 16 kHz mono f32.
pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Mic,
    System,
}

impl Source {
    pub fn as_str(&self) -> &'static str {
        match self {
            Source::Mic    => "mic",
            Source::System => "system",
        }
    }
}

pub struct AudioChunk {
    pub source  : Source,
    pub samples : Vec<f32>,
}
