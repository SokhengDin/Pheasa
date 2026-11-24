use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DevicePref {
    #[default]
    Auto,
    Cpu,
    Cuda,
    Metal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MtBackend {
    #[default]
    Local,
    Cloud,
}

/// Any OpenAI-compatible chat-completions endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudConfig {
    pub base_url : String,
    pub api_key  : String,
    pub model    : String,
}

impl Default for CloudConfig {
    fn default() -> Self {
        Self {
            base_url : "https://api.openai.com/v1".to_string(),
            api_key  : String::new(),
            model    : String::new(),
        }
    }
}

/// A term to keep as written, or to translate your way: "Pitchtree" stays
/// "Pitchtree"; "stage" can be forced to "internship".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlossaryEntry {
    pub from : String,
    pub to   : String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub source_lang              : String,
    pub target_lang              : String,
    pub device                   : DevicePref,
    pub stt_model                : Option<String>,
    pub mt_backend               : MtBackend,
    pub mt_model                 : Option<String>,
    pub cloud                    : CloudConfig,
    pub capture_mic              : bool,
    pub capture_system           : bool,
    pub mic_device               : Option<String>,
    pub system_device            : Option<String>,
    pub separate_remote_speakers : bool,
    pub speaker_threshold        : f32,
    pub neural_vad               : bool,
    pub echo_guard               : bool,
    pub speaker_model            : Option<String>,
    pub mt_model_2               : Option<String>,
    pub tts_model                : Option<String>,
    pub speak_translation        : bool,
    pub glossary                 : Vec<GlossaryEntry>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            source_lang              : "fr".to_string(),
            target_lang              : "en".to_string(),
            device                   : DevicePref::Auto,
            stt_model                : None,
            mt_backend               : MtBackend::Local,
            mt_model                 : None,
            cloud                    : CloudConfig::default(),
            capture_mic              : true,
            capture_system           : true,
            mic_device               : None,
            system_device            : None,
            separate_remote_speakers : true,
            speaker_threshold        : 0.45,
            neural_vad               : true,
            echo_guard               : true,
            speaker_model            : None,
            mt_model_2               : None,
            tts_model                : None,
            speak_translation        : false,
            glossary                 : Vec::new(),
        }
    }
}

impl DevicePref {
    /// The device name the Python side understands.
    pub fn python_name(&self) -> &'static str {
        match self {
            DevicePref::Auto  => "auto",
            DevicePref::Cpu   => "cpu",
            DevicePref::Cuda  => "cuda",
            DevicePref::Metal => "mps",
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::write(path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("writing {}", path.display()))
    }
}
