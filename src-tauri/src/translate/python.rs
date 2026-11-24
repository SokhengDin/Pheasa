//! Translation through the embedded Python runtime. Two slots let a
//! translation pivot through English (for example fr -> en -> de).

use std::path::Path;

use anyhow::Result;
use serde_json::json;

use super::Translator;
use crate::runtime;

pub struct PyTranslator {
    slot: String,
}

impl PyTranslator {
    /// `engine` is "hf" (transformers) or "mlx" (Apple GPU).
    pub fn load(dir: &Path, device: &str, engine: &str, slot: &str, src: &str, tgt: &str) -> Result<Self> {
        runtime::call(
            "load_mt",
            json!({
                "model_dir" : dir.to_string_lossy(),
                "device"    : device,
                "engine"    : engine,
                "slot"      : slot,
                "src"       : src,
                "tgt"       : tgt,
            }),
            None,
        )?;

        Ok(Self { slot: slot.to_string() })
    }
}

impl Translator for PyTranslator {
    fn translate(&mut self, text: &str) -> Result<String> {
        let reply = runtime::call("translate", json!({ "slot": self.slot, "text": text }), None)?;

        Ok(reply["text"].as_str().unwrap_or("").trim().to_string())
    }
}
