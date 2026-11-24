pub mod python;
pub mod whisper;

use anyhow::Result;

pub use python::PyStt;
pub use whisper::WhisperStt;

/// Anything that turns a 16 kHz mono segment into text: the built-in Whisper
/// (candle) or a Hugging Face model running in the Python runtime.
pub trait Transcriber: Send {
    fn transcribe(&mut self, pcm: &[f32], lang: &str) -> Result<String>;
}

impl Transcriber for WhisperStt {
    fn transcribe(&mut self, pcm: &[f32], lang: &str) -> Result<String> {
        WhisperStt::transcribe(self, pcm, lang)
    }
}
