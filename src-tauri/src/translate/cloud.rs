//! Cloud translation through any OpenAI-compatible chat-completions endpoint.
//!
//! The HTTP client is created lazily on the engine thread, because a blocking
//! reqwest client must not be built or dropped inside an async runtime.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use super::{language_name, Translator};
use crate::settings::CloudConfig;

pub struct CloudTranslator {
    config        : CloudConfig,
    system_prompt : String,
    client        : Option<reqwest::blocking::Client>,
}

impl CloudTranslator {
    pub fn new(config: CloudConfig, source: &str, target: &str) -> Result<Self> {
        if config.base_url.trim().is_empty() || config.model.trim().is_empty() {
            bail!("Fill in the cloud base URL and model in Settings first");
        }

        let system_prompt = format!(
            "You are a live interpreter. Translate the user's message from {} to {}. \
             Reply with the translation only, with no notes and no quotation marks.",
            language_name(source),
            language_name(target),
        );

        Ok(Self { config, system_prompt, client: None })
    }
}

impl Translator for CloudTranslator {
    fn translate(&mut self, text: &str) -> Result<String> {
        if self.client.is_none() {
            self.client = Some(
                reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(20))
                    .user_agent("pheasa/0.1")
                    .build()?,
            );
        }

        let client = self.client.as_ref().ok_or_else(|| anyhow!("http client missing"))?;
        let url    = format!("{}/chat/completions", self.config.base_url.trim_end_matches('/'));

        let body = json!({
            "model"       : self.config.model,
            "temperature" : 0,
            "messages"    : [
                { "role": "system", "content": self.system_prompt },
                { "role": "user",   "content": text },
            ],
        });

        let mut request = client.post(url).json(&body);

        if !self.config.api_key.is_empty() {
            request = request.bearer_auth(&self.config.api_key);
        }

        let response: Value = request.send()?.error_for_status()?.json()?;

        response["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.trim().to_string())
            .ok_or_else(|| anyhow!("unexpected response from the translation API"))
    }
}
