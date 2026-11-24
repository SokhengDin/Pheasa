//! Speech-to-text through the embedded Python runtime (transformers pipeline).

use std::path::Path;

use anyhow::Result;
use serde_json::json;

use super::Transcriber;
use crate::runtime;

pub struct PyStt;

impl PyStt {
    /// `engine` is "hf" (transformers) or "mlx" (Apple GPU).
    pub fn load(dir: &Path, device: &str, engine: &str) -> Result<Self> {
        runtime::call(
            "load_stt",
            json!({ "model_dir": dir.to_string_lossy(), "device": device, "engine": engine }),
            None,
        )?;

        Ok(Self)
    }
}

impl Transcriber for PyStt {
    fn transcribe(&mut self, pcm: &[f32], lang: &str) -> Result<String> {
        let reply = runtime::call("transcribe", json!({ "lang": lang }), Some(pcm))?;

        Ok(reply["text"].as_str().unwrap_or("").trim().to_string())
    }
}
