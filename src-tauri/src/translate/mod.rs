pub mod cloud;
pub mod marian;
pub mod python;

use anyhow::Result;
use regex::{Regex, RegexBuilder};

use crate::settings::GlossaryEntry;

pub trait Translator: Send {
    fn translate(&mut self, text: &str) -> Result<String>;
}

/// Used when the source and target language are the same.
pub struct Passthrough;

impl Translator for Passthrough {
    fn translate(&mut self, text: &str) -> Result<String> {
        Ok(text.to_string())
    }
}

/// Runs two translators one after the other (source to English, then English
/// to the target), for language pairs no single model covers.
pub struct ChainTranslator {
    first  : Box<dyn Translator>,
    second : Box<dyn Translator>,
}

impl ChainTranslator {
    pub fn new(first: Box<dyn Translator>, second: Box<dyn Translator>) -> Self {
        Self { first, second }
    }
}

impl Translator for ChainTranslator {
    fn translate(&mut self, text: &str) -> Result<String> {
        let middle = self.first.translate(text)?;
        self.second.translate(&middle)
    }
}

/// Applies the user's glossary to the source text before translating, so
/// names and terms come out the way the user wants them.
pub struct GlossaryTranslator {
    inner   : Box<dyn Translator>,
    entries : Vec<(Regex, String)>,
}

impl GlossaryTranslator {
    pub fn wrap(inner: Box<dyn Translator>, glossary: &[GlossaryEntry]) -> Box<dyn Translator> {
        let entries: Vec<(Regex, String)> = glossary
            .iter()
            .filter(|e| !e.from.trim().is_empty())
            .filter_map(|e| {
                let pattern = format!(r"\b{}\b", regex::escape(e.from.trim()));

                RegexBuilder::new(&pattern)
                    .case_insensitive(true)
                    .build()
                    .ok()
                    .map(|re| (re, e.to.clone()))
            })
            .collect();

        if entries.is_empty() {
            inner
        } else {
            Box::new(Self { inner, entries })
        }
    }
}

impl Translator for GlossaryTranslator {
    fn translate(&mut self, text: &str) -> Result<String> {
        let mut prepared = text.to_string();

        for (re, to) in &self.entries {
            prepared = re.replace_all(&prepared, regex::NoExpand(to)).into_owned();
        }

        self.inner.translate(&prepared)
    }
}

/// Every language Whisper can transcribe. The cloud backend can translate
/// between any of them, so this is also the list the interface offers.
pub const LANGUAGES: &[(&str, &str)] = &[
    ("af", "Afrikaans"),   ("am", "Amharic"),      ("ar", "Arabic"),       ("as", "Assamese"),
    ("az", "Azerbaijani"), ("ba", "Bashkir"),      ("be", "Belarusian"),   ("bg", "Bulgarian"),
    ("bn", "Bengali"),     ("bo", "Tibetan"),      ("br", "Breton"),       ("bs", "Bosnian"),
    ("ca", "Catalan"),     ("cs", "Czech"),        ("cy", "Welsh"),        ("da", "Danish"),
    ("de", "German"),      ("el", "Greek"),        ("en", "English"),      ("es", "Spanish"),
    ("et", "Estonian"),    ("eu", "Basque"),       ("fa", "Persian"),      ("fi", "Finnish"),
    ("fo", "Faroese"),     ("fr", "French"),       ("gl", "Galician"),     ("gu", "Gujarati"),
    ("ha", "Hausa"),       ("haw", "Hawaiian"),    ("he", "Hebrew"),       ("hi", "Hindi"),
    ("hr", "Croatian"),    ("ht", "Haitian Creole"), ("hu", "Hungarian"),  ("hy", "Armenian"),
    ("id", "Indonesian"),  ("is", "Icelandic"),    ("it", "Italian"),      ("ja", "Japanese"),
    ("jw", "Javanese"),    ("ka", "Georgian"),     ("kk", "Kazakh"),       ("km", "Khmer"),
    ("kn", "Kannada"),     ("ko", "Korean"),       ("la", "Latin"),        ("lb", "Luxembourgish"),
    ("ln", "Lingala"),     ("lo", "Lao"),          ("lt", "Lithuanian"),   ("lv", "Latvian"),
    ("mg", "Malagasy"),    ("mi", "Maori"),        ("mk", "Macedonian"),   ("ml", "Malayalam"),
    ("mn", "Mongolian"),   ("mr", "Marathi"),      ("ms", "Malay"),        ("mt", "Maltese"),
    ("my", "Myanmar"),     ("ne", "Nepali"),       ("nl", "Dutch"),        ("nn", "Nynorsk"),
    ("no", "Norwegian"),   ("oc", "Occitan"),      ("pa", "Punjabi"),      ("pl", "Polish"),
    ("ps", "Pashto"),      ("pt", "Portuguese"),   ("ro", "Romanian"),     ("ru", "Russian"),
    ("sa", "Sanskrit"),    ("sd", "Sindhi"),       ("si", "Sinhala"),      ("sk", "Slovak"),
    ("sl", "Slovenian"),   ("sn", "Shona"),        ("so", "Somali"),       ("sq", "Albanian"),
    ("sr", "Serbian"),     ("su", "Sundanese"),    ("sv", "Swedish"),      ("sw", "Swahili"),
    ("ta", "Tamil"),       ("te", "Telugu"),       ("tg", "Tajik"),        ("th", "Thai"),
    ("tk", "Turkmen"),     ("tl", "Tagalog"),      ("tr", "Turkish"),      ("tt", "Tatar"),
    ("uk", "Ukrainian"),   ("ur", "Urdu"),         ("uz", "Uzbek"),        ("vi", "Vietnamese"),
    ("yi", "Yiddish"),     ("yo", "Yoruba"),       ("yue", "Cantonese"),   ("zh", "Chinese"),
];

pub fn language_name(code: &str) -> &str {
    if code == "auto" {
        return "its original language (detect it)";
    }

    LANGUAGES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, name)| *name)
        .unwrap_or(code)
}
