//! Local neural machine translation with Marian (Helsinki-NLP opus-mt) on candle.
//!
//! Weights come from `model.safetensors`, or from `pytorch_model.bin` when the
//! repository has no safetensors file. The model directory holds
//! `tokenizer-src.json` and `tokenizer-tgt.json`, written by the downloader.

use std::path::Path;

use anyhow::{anyhow, Result};
use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::marian;
use tokenizers::Tokenizer;

use super::Translator;

pub struct MarianTranslator {
    model     : marian::MTModel,
    config    : marian::Config,
    tok_src   : Tokenizer,
    tok_tgt   : Tokenizer,
    device    : Device,
}

impl MarianTranslator {
    pub fn load(dir: &Path, device: Device) -> Result<Self> {
        let config: marian::Config = serde_json::from_slice(&std::fs::read(dir.join("config.json"))?)?;

        let read_tokenizer = |name: &str| -> Result<Tokenizer> {
            Tokenizer::from_file(dir.join(name)).map_err(|err| anyhow!("cannot read {name}: {err}"))
        };

        let tok_src = read_tokenizer("tokenizer-src.json")?;
        let tok_tgt = read_tokenizer("tokenizer-tgt.json")?;

        let safetensors = dir.join("model.safetensors");
        let pickle      = dir.join("pytorch_model.bin");

        let vb = if safetensors.exists() {
            // Marian ties the shared embedding to the encoder and decoder ones, and
            // safetensors files often store only one copy under another name.
            let mut tensors = candle_core::safetensors::load(&safetensors, &device)?;

            if !tensors.contains_key("model.shared.weight") {
                let alias = ["model.encoder.embed_tokens.weight", "model.decoder.embed_tokens.weight", "lm_head.weight"]
                    .iter()
                    .find_map(|name| tensors.get(*name).cloned())
                    .ok_or_else(|| anyhow!("cannot find the shared embedding in model.safetensors"))?;

                tensors.insert("model.shared.weight".to_string(), alias);
            }

            VarBuilder::from_tensors(tensors, DType::F32, &device)
        } else {
            VarBuilder::from_pth(&pickle, DType::F32, &device)?
        };

        let model = marian::MTModel::new(&config, vb)?;

        Ok(Self { model, config, tok_src, tok_tgt, device })
    }
}

impl Translator for MarianTranslator {
    fn translate(&mut self, text: &str) -> Result<String> {
        let text = text.trim();

        if text.is_empty() {
            return Ok(String::new());
        }

        self.model.reset_kv_cache();

        let encoding = self
            .tok_src
            .encode(text, true)
            .map_err(|err| anyhow!("cannot tokenize: {err}"))?;

        let mut source_ids = encoding.get_ids().to_vec();
        source_ids.push(self.config.eos_token_id);

        let source     = Tensor::new(source_ids.as_slice(), &self.device)?.unsqueeze(0)?;
        let encoder_xs = self.model.encoder().forward(&source, 0)?;

        let max_new         = (source_ids.len() * 3 + 16).min(400);
        let mut output_ids  = vec![self.config.decoder_start_token_id];

        for step in 0..max_new {
            let context = if step >= 1 { 1 } else { output_ids.len() };
            let start   = output_ids.len().saturating_sub(context);
            let input   = Tensor::new(&output_ids[start..], &self.device)?.unsqueeze(0)?;

            let logits = self.model.decode(&input, &encoder_xs, start)?;
            let logits = logits.squeeze(0)?;
            let last   = logits.get(logits.dim(0)? - 1)?;
            let next   = last.argmax(0)?.to_scalar::<u32>()?;

            output_ids.push(next);

            if next == self.config.eos_token_id || next == self.config.forced_eos_token_id {
                break;
            }
        }

        let translated = self
            .tok_tgt
            .decode(&output_ids, true)
            .map_err(|err| anyhow!("cannot decode translation: {err}"))?;

        // Some Marian vocabularies keep markers such as <NIL> as ordinary tokens.
        let cleaned = ["<NIL>", "</s>", "<pad>", "<unk>"]
            .iter()
            .fold(translated, |text, marker| text.replace(marker, ""));

        Ok(cleaned.split_whitespace().collect::<Vec<_>>().join(" "))
    }
}
