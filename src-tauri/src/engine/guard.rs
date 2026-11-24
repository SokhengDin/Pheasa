//! Keeps junk out of the transcript.
//!
//! Two kinds of junk, both seen in real meetings:
//!
//! * Echo: the microphone hears the speakers playing the remote side, so every
//!   remote sentence comes back a second time as "You". `EchoGate` silences the
//!   microphone while the remote side is loud and the microphone is not (audio
//!   level), and `EchoFilter` drops a microphone line that repeats a recent
//!   remote line (text).
//! * Made-up text: speech models invent words on noise and silence, or loop on
//!   one phrase. `is_junk` rejects those before they are translated.

use std::collections::VecDeque;

use crate::audio::Source;

/// The remote side counts as "talking" above this level.
const SYSTEM_ACTIVE : f32 = 0.004;

/// Bleed lingers after the remote voice stops (room tail, device delay).
const HOLD_MS       : u64 = 700;

/// A microphone chunk quieter than this share of the remote level is bleed.
/// A person speaking into the microphone is normally much louder than the echo.
const BLEED_RATIO   : f32 = 0.6;

/// How far apart, in milliseconds, an echo and its source may be.
const ECHO_BEFORE_MS: u64 = 12_000;
const ECHO_AFTER_MS : u64 = 3_000;
const KEEP_MS       : u64 = 40_000;

/// Text similarity (0..1) above which a microphone line is an echo.
const ECHO_SIMILAR  : f32   = 0.45;
const ECHO_SHORT    : f32   = 0.85;
const SHORT_CHARS   : usize = 8;

/// More characters per second than anyone can speak.
const MAX_CHARS_PER_SECOND: f32 = 45.0;

const STOCK_PHRASES: [&str; 7] = [
    "thanksforwatching",
    "thankyouforwatching",
    "pleasesubscribe",
    "subscribetomychannel",
    "subtitlesby",
    "amaraorg",
    "transcribedby",
];

/// Audio-level echo suppression. Feed it every chunk, in arrival order.
pub struct EchoGate {
    level   : f32,
    last_ms : Option<u64>,
}

impl EchoGate {
    pub fn new() -> Self {
        Self { level: 0.0, last_ms: None }
    }

    /// Returns true when this microphone chunk is most likely the speakers
    /// leaking back in, so the caller should replace it with silence.
    /// Always false for the system source.
    pub fn is_bleed(&mut self, source: Source, rms: f32, now_ms: u64) -> bool {
        match source {
            Source::System => {
                if rms > SYSTEM_ACTIVE {
                    self.level   = (self.level * 0.995).max(rms);
                    self.last_ms = Some(now_ms);
                }

                false
            }
            Source::Mic => match self.last_ms {
                Some(last) => now_ms.saturating_sub(last) < HOLD_MS && rms < self.level * BLEED_RATIO,
                None       => false,
            },
        }
    }
}

impl Default for EchoGate {
    fn default() -> Self {
        Self::new()
    }
}

/// Text-level echo detection over recent remote lines.
pub struct EchoFilter {
    remote: VecDeque<(String, u64)>,
}

impl EchoFilter {
    pub fn new() -> Self {
        Self { remote: VecDeque::new() }
    }

    /// Remember a finished remote line.
    pub fn note_remote(&mut self, text: &str, ended_ms: u64) {
        let norm = normalize(text);

        if norm.is_empty() {
            return;
        }

        self.remote.push_back((norm, ended_ms));

        while self.remote.front().is_some_and(|(_, end)| end + KEEP_MS < ended_ms) {
            self.remote.pop_front();
        }
    }

    /// True when a microphone line repeats something the remote side just said.
    pub fn is_echo(&self, text: &str, started_ms: u64, ended_ms: u64) -> bool {
        let norm = normalize(text);

        if norm.is_empty() {
            return false;
        }

        let short = norm.chars().count() < SHORT_CHARS;
        let need  = if short { ECHO_SHORT } else { ECHO_SIMILAR };

        self.remote.iter().any(|(other, end)| {
            let near = *end + ECHO_BEFORE_MS >= started_ms && *end <= ended_ms + ECHO_AFTER_MS;

            near && similarity(&norm, other) >= need
        })
    }
}

impl Default for EchoFilter {
    fn default() -> Self {
        Self::new()
    }
}

/// Letters and digits plus the combining marks of scripts like Khmer and Thai,
/// lowercased, with spaces and punctuation removed.
pub fn normalize(text: &str) -> String {
    text.chars()
        .filter(|&c| c.is_alphanumeric() || is_mark(c))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn is_mark(c: char) -> bool {
    matches!(
        c as u32,
        0x0300..=0x036F      // combining diacritics
        | 0x0900..=0x0DFF    // Indic scripts
        | 0x0E30..=0x0E4E    // Thai vowels and tones
        | 0x1780..=0x17D3    // Khmer letters, vowels and signs (not the Khmer punctuation)
        | 0x17DD
    )
}

/// Dice coefficient over character pairs. Works without word boundaries, so it
/// suits Khmer, Thai and Chinese as well as spaced languages.
pub fn similarity(a: &str, b: &str) -> f32 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();

    if a.len() < 2 || b.len() < 2 {
        return if a == b && !a.is_empty() { 1.0 } else { 0.0 };
    }

    let mut pairs: Vec<(char, char)> = b.windows(2).map(|w| (w[0], w[1])).collect();
    let mut shared = 0_usize;

    for pair in a.windows(2).map(|w| (w[0], w[1])) {
        if let Some(at) = pairs.iter().position(|p| *p == pair) {
            pairs.swap_remove(at);
            shared += 1;
        }
    }

    2.0 * shared as f32 / ((a.len() - 1) + (b.len() - 1)) as f32
}

/// True when the transcription is something the speech model made up.
pub fn is_junk(text: &str, audio_ms: u64) -> bool {
    let norm  = normalize(text);
    let chars = norm.chars().count();

    if chars == 0 {
        return true;
    }

    let seconds = audio_ms as f32 / 1000.0;

    if seconds > 0.0 && chars as f32 / seconds > MAX_CHARS_PER_SECOND {
        return true;
    }

    if repeats_itself(text, &norm) {
        return true;
    }

    seconds < 4.0 && STOCK_PHRASES.iter().any(|phrase| norm.contains(phrase))
}

/// A loop such as "so so so so so so" or "ខ្ញុំខ្ញុំខ្ញុំខ្ញុំខ្ញុំ".
fn repeats_itself(text: &str, norm: &str) -> bool {
    let words: Vec<String> = text.split_whitespace().map(normalize).filter(|w| !w.is_empty()).collect();

    if words.len() >= 6 {
        let mut unique = words.clone();
        unique.sort();
        unique.dedup();

        if (unique.len() as f32) / (words.len() as f32) < 0.34 {
            return true;
        }
    }

    let chars: Vec<char> = norm.chars().collect();
    let total            = chars.len();

    if total < 8 {
        return false;
    }

    for unit in 1..=12_usize {
        if unit * 4 > total {
            break;
        }

        let mut start = 0;

        while start + unit * 4 <= total {
            let mut reps = 1;

            while start + unit * (reps + 1) <= total
                && chars[start..start + unit] == chars[start + unit * reps..start + unit * (reps + 1)]
            {
                reps += 1;
            }

            if reps >= 4 && unit * reps * 10 >= total * 6 {
                return true;
            }

            start += if reps > 1 { unit * reps } else { 1 };
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_is_an_echo() {
        let mut filter = EchoFilter::new();
        filter.note_remote("ខ្ញុំគិតថា ខ្ញុំអាចធ្វើឱ្យអ្នកសប្បាយចិត្តក្នុងរយៈពេលជាងពីរម៉ោង។", 7_000);

        assert!(filter.is_echo("ខ្ញុំគិតថា ខ្ញុំអាចធ្វើឱ្យអ្នកសប្បាយចិត្តក្នុងរយៈពេលជាងពីរម៉ោង។", 7_000, 7_400));
    }

    #[test]
    fn noisy_copy_of_the_same_sentence_is_an_echo() {
        // Real pair from a meeting: the remote line and the worse copy the mic made of it.
        let mut filter = EchoFilter::new();
        filter.note_remote("បាទ ល្បិចមួយគឺដូចជា ការសម្រាប់ការឆ្លើយតបដែលតឹងតឹឡើង", 132_000);

        assert!(filter.is_echo("បាទ ល្បិចមួយគឺដូចជា សំណើដែលតឹងតែងជាង", 131_000, 135_000));
    }

    #[test]
    fn different_speech_is_kept() {
        let mut filter = EchoFilter::new();
        filter.note_remote("So this is the explanation of what I said to you guys", 10_000);

        assert!(!filter.is_echo("Can you estimate when you could give us the result", 11_000, 14_000));
    }

    #[test]
    fn old_remote_lines_do_not_match() {
        let mut filter = EchoFilter::new();
        filter.note_remote("Okay that is good for me thank you", 1_000);

        assert!(!filter.is_echo("Okay that is good for me thank you", 60_000, 62_000));
    }

    #[test]
    fn short_answers_need_an_exact_match() {
        let mut filter = EchoFilter::new();
        filter.note_remote("Yes sure", 10_000);

        assert!(!filter.is_echo("Yes I do", 10_500, 11_000));
        assert!(filter.is_echo("yes, sure!", 10_500, 11_000));
    }

    #[test]
    fn quiet_mic_while_remote_talks_is_bleed() {
        let mut gate = EchoGate::new();

        gate.is_bleed(Source::System, 0.08, 1_000);

        assert!(gate.is_bleed(Source::Mic, 0.02, 1_100));
        assert!(!gate.is_bleed(Source::Mic, 0.09, 1_100), "a person speaking over the call is louder than the echo");
        assert!(!gate.is_bleed(Source::Mic, 0.02, 2_000), "bleed stops once the remote side has been quiet");
    }

    #[test]
    fn mic_is_never_bleed_without_remote_audio() {
        let mut gate = EchoGate::new();

        assert!(!gate.is_bleed(Source::Mic, 0.001, 500));
    }

    #[test]
    fn junk_is_rejected() {
        assert!(is_junk("", 2_000));
        assert!(is_junk("...", 2_000));
        assert!(is_junk("so so so so so so so so", 3_000));
        assert!(is_junk("ខ្ញុំខ្ញុំខ្ញុំខ្ញុំខ្ញុំខ្ញុំខ្ញុំខ្ញុំ", 3_000));
        assert!(is_junk("Thanks for watching!", 1_500));
        assert!(is_junk(&"a".repeat(200), 1_000));
    }

    #[test]
    fn real_speech_is_kept() {
        assert!(!is_junk("Okay, so now there are six rules, not just four.", 4_000));
        assert!(!is_junk("បាទ ខ្ញុំកំពុងធ្វើវានៅពេលនេះ។", 2_500));
        assert!(!is_junk("Thanks for watching the results with us today, let's move on to the next point.", 6_000));
        assert!(!is_junk("Yeah.", 800));
    }
}
