"""Pheasa Python module.

Embedded in the Rust app through PyO3 and called in-process, so there is no
separate server. Rust only ever passes folders inside its own data directory,
and sets HF_HUB_OFFLINE, so nothing is downloaded or cached anywhere else.

Rust calls `dispatch(op, args_json, pcm_bytes)` and gets a JSON string back:
    {"ok": true, ...}   or   {"error": "message"}
"""

import gc
import inspect
import io
import json
import os
import re
import sys
import traceback
import wave
import base64

import numpy as np
import torch

STATE = {}
OPS   = {}


class no_grad:
    """`torch.no_grad()` that carries on when the embedded interpreter cannot switch grad mode.

    Inside the app some builds of torch raise a TypeError from `set_grad_enabled`. Inference
    here never needs gradients, so skipping the switch only costs a little memory.
    """

    def __enter__(self):
        try:
            self._cm = torch.no_grad()
            self._cm.__enter__()
        except TypeError:
            self._cm = None

        return self

    def __exit__(self, *exc):
        if self._cm is None:
            return False

        try:
            return self._cm.__exit__(*exc)
        except TypeError:
            return False

SAMPLE_RATE = 16000


def op(name):
    def register(fn):
        OPS[name] = fn
        return fn
    return register


def pick_device(pref):
    pref = (pref or "auto").lower()

    if pref == "cpu":
        return "cpu"

    if pref == "cuda" and torch.cuda.is_available():
        return "cuda"

    if pref in ("mps", "metal") and torch.backends.mps.is_available():
        return "mps"

    if torch.cuda.is_available():
        return "cuda"

    if torch.backends.mps.is_available():
        return "mps"

    return "cpu"


def device_label(device):
    return {"cuda": "CUDA", "mps": "Metal", "cpu": "CPU"}[device]


def dtype_for(device):
    return torch.float16 if device == "cuda" else torch.float32


def decode_pcm(raw):
    """Little-endian float32 samples, 16 kHz mono, as raw bytes."""
    return np.frombuffer(raw, dtype="<f4").copy()


def make_pipeline(task, model_dir, device):
    from transformers import pipeline

    try:
        return pipeline(task, model=model_dir, device=device, dtype=dtype_for(device))
    except TypeError:
        return pipeline(task, model=model_dir, device=device, torch_dtype=dtype_for(device))


# Language codes -------------------------------------------------------------

FLORES = {
    "af": "afr_Latn", "am": "amh_Ethi", "ar": "arb_Arab", "as": "asm_Beng", "az": "azj_Latn",
    "ba": "bak_Cyrl", "be": "bel_Cyrl", "bg": "bul_Cyrl", "bn": "ben_Beng", "bo": "bod_Tibt",
    "bs": "bos_Latn", "ca": "cat_Latn", "cs": "ces_Latn", "cy": "cym_Latn", "da": "dan_Latn",
    "de": "deu_Latn", "el": "ell_Grek", "en": "eng_Latn", "es": "spa_Latn", "et": "est_Latn",
    "eu": "eus_Latn", "fa": "pes_Arab", "fi": "fin_Latn", "fo": "fao_Latn", "fr": "fra_Latn",
    "gl": "glg_Latn", "gu": "guj_Gujr", "ha": "hau_Latn", "he": "heb_Hebr", "hi": "hin_Deva",
    "hr": "hrv_Latn", "ht": "hat_Latn", "hu": "hun_Latn", "hy": "hye_Armn", "id": "ind_Latn",
    "is": "isl_Latn", "it": "ita_Latn", "ja": "jpn_Jpan", "jw": "jav_Latn", "ka": "kat_Geor",
    "kk": "kaz_Cyrl", "km": "khm_Khmr", "kn": "kan_Knda", "ko": "kor_Hang", "lb": "ltz_Latn",
    "ln": "lin_Latn", "lo": "lao_Laoo", "lt": "lit_Latn", "lv": "lvs_Latn", "mg": "plt_Latn",
    "mi": "mri_Latn", "mk": "mkd_Cyrl", "ml": "mal_Mlym", "mn": "khk_Cyrl", "mr": "mar_Deva",
    "ms": "zsm_Latn", "mt": "mlt_Latn", "my": "mya_Mymr", "ne": "npi_Deva", "nl": "nld_Latn",
    "nn": "nno_Latn", "no": "nob_Latn", "pa": "pan_Guru", "pl": "pol_Latn", "ps": "pbt_Arab",
    "pt": "por_Latn", "ro": "ron_Latn", "ru": "rus_Cyrl", "sa": "san_Deva", "sd": "snd_Arab",
    "si": "sin_Sinh", "sk": "slk_Latn", "sl": "slv_Latn", "sn": "sna_Latn", "so": "som_Latn",
    "sq": "als_Latn", "sr": "srp_Cyrl", "su": "sun_Latn", "sv": "swe_Latn", "sw": "swh_Latn",
    "ta": "tam_Taml", "te": "tel_Telu", "tg": "tgk_Cyrl", "th": "tha_Thai", "tk": "tuk_Latn",
    "tl": "tgl_Latn", "tr": "tur_Latn", "tt": "tat_Cyrl", "uk": "ukr_Cyrl", "ur": "urd_Arab",
    "uz": "uzn_Latn", "vi": "vie_Latn", "yo": "yor_Latn", "yue": "yue_Hant", "zh": "zho_Hans",
}

MBART = {
    "af": "af_ZA", "ar": "ar_AR", "az": "az_AZ", "bn": "bn_IN", "cs": "cs_CZ", "de": "de_DE",
    "en": "en_XX", "es": "es_XX", "et": "et_EE", "fa": "fa_IR", "fi": "fi_FI", "fr": "fr_XX",
    "gl": "gl_ES", "gu": "gu_IN", "he": "he_IL", "hi": "hi_IN", "hr": "hr_HR", "id": "id_ID",
    "it": "it_IT", "ja": "ja_XX", "ka": "ka_GE", "kk": "kk_KZ", "km": "km_KH", "ko": "ko_KR",
    "lt": "lt_LT", "lv": "lv_LV", "mk": "mk_MK", "ml": "ml_IN", "mn": "mn_MN", "mr": "mr_IN",
    "my": "my_MM", "ne": "ne_NP", "nl": "nl_XX", "pl": "pl_PL", "ps": "ps_AF", "pt": "pt_XX",
    "ro": "ro_RO", "ru": "ru_RU", "si": "si_LK", "sl": "sl_SI", "sv": "sv_SE", "sw": "sw_KE",
    "ta": "ta_IN", "te": "te_IN", "th": "th_TH", "tl": "tl_XX", "tr": "tr_TR", "uk": "uk_UA",
    "ur": "ur_PK", "vi": "vi_VN", "zh": "zh_CN",
}


def code_for(table, lang, kind):
    if lang not in table:
        raise ValueError(f"The {kind} model has no code for the language '{lang}'")
    return table[lang]



LANG_NAMES = {
    "af": "Afrikaans", "ar": "Arabic", "bg": "Bulgarian", "bn": "Bengali", "ca": "Catalan",
    "cs": "Czech", "da": "Danish", "de": "German", "el": "Greek", "en": "English",
    "es": "Spanish", "et": "Estonian", "eu": "Basque", "fa": "Persian", "fi": "Finnish",
    "fr": "French", "gl": "Galician", "he": "Hebrew", "hi": "Hindi", "hr": "Croatian",
    "hu": "Hungarian", "id": "Indonesian", "it": "Italian", "ja": "Japanese", "ka": "Georgian",
    "kk": "Kazakh", "km": "Khmer", "ko": "Korean", "lo": "Lao", "lt": "Lithuanian",
    "lv": "Latvian", "mn": "Mongolian", "ms": "Malay", "my": "Burmese", "ne": "Nepali",
    "nl": "Dutch", "no": "Norwegian", "pl": "Polish", "pt": "Portuguese", "ro": "Romanian",
    "ru": "Russian", "sk": "Slovak", "sl": "Slovenian", "sr": "Serbian", "sv": "Swedish",
    "sw": "Swahili", "ta": "Tamil", "th": "Thai", "tl": "Filipino", "tr": "Turkish",
    "uk": "Ukrainian", "ur": "Urdu", "vi": "Vietnamese", "zh": "Chinese", "yue": "Cantonese",
}


def lang_name(code):
    return LANG_NAMES.get(code, code)


# MLX (Apple GPU) -------------------------------------------------------------

def mlx_place(pref):
    """MLX runs on the Apple GPU unless the person chose the CPU."""
    import mlx.core as mx

    cpu = (pref or "auto").lower() == "cpu"
    mx.set_default_device(mx.cpu if cpu else mx.gpu)

    return "CPU (MLX)" if cpu else "Apple GPU (MLX)"


def repo_name_parts(model_dir):
    """mlx-audio picks the model family from the repository name, and a local
    folder name has the owner glued on, so recover the real id from meta.json."""
    from mlx_audio.utils import get_model_name_parts

    try:
        with open(os.path.join(model_dir, "meta.json"), encoding="utf-8") as fh:
            repo = json.load(fh)["id"]
    except (OSError, KeyError, ValueError):
        repo = os.path.basename(model_dir.rstrip("/\\"))

    return get_model_name_parts(repo)


def load_stt_mlx(req):
    model_dir = req["model_dir"]
    place     = mlx_place(req.get("device"))

    STATE.pop("stt", None)
    gc.collect()

    if any(os.path.exists(os.path.join(model_dir, name)) for name in ("weights.npz", "weights.safetensors")):
        # The mlx-whisper layout: config.json plus weights.npz or weights.safetensors.
        import mlx_whisper

        # One silent second loads the weights now, so the first sentence is not slow.
        mlx_whisper.transcribe(
            np.zeros(SAMPLE_RATE, dtype=np.float32), path_or_hf_repo=model_dir, verbose=None,
        )

        STATE["stt"] = {"kind": "mlx_whisper", "dir": model_dir}
    else:
        from pathlib import Path
        from mlx_audio.stt.utils import load_model

        model = load_model(Path(model_dir), model_name_parts=repo_name_parts(model_dir))

        STATE["stt"] = {"kind": "mlx_audio", "model": model}

    return {"device": place}


def transcribe_mlx(entry, audio, lang):
    language = None if lang in (None, "", "auto") else lang

    if entry["kind"] == "mlx_whisper":
        import mlx_whisper

        out = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=entry["dir"],
            language=language,
            condition_on_previous_text=False,
            verbose=None,
        )

        return {"text": (out.get("text") or "").strip()}

    import mlx.core as mx

    model  = entry["model"]
    kwargs = {}

    if language and "language" in inspect.signature(model.generate).parameters:
        kwargs["language"] = language

    out = model.generate(mx.array(audio), **kwargs)

    return {"text": (getattr(out, "text", "") or "").strip()}


def load_mt_mlx(req):
    from mlx_lm import load

    place = mlx_place(req.get("device"))

    model, tok = load(req["model_dir"])

    # Same slot scheme as the transformers models, so a pivot through English works.
    STATE["mt:" + req.get("slot", "mt")] = {
        "kind": "mlx_lm", "tok": tok, "model": model, "src": req["src"], "tgt": req["tgt"],
    }

    return {"device": place, "kind": "mlx_lm"}


def translate_mlx(mt, text):
    from mlx_lm import generate
    from mlx_lm.sample_utils import make_sampler

    src, tgt = mt["src"], mt["tgt"]
    tok      = mt["tok"]

    if src == "auto":
        raise ValueError("Automatic language detection needs the cloud translation backend")

    ask = (
        f"Translate the following text from {lang_name(src)} to {lang_name(tgt)}. "
        "Reply with the translation only, without notes or explanation.\n\n" + text
    )

    if getattr(tok, "chat_template", None):
        prompt = tok.apply_chat_template(
            [{"role": "user", "content": ask}],
            add_generation_prompt=True,
            tokenize=False,
            enable_thinking=False,
        )
    else:
        prompt = ask

    out = generate(
        mt["model"],
        tok,
        prompt     = prompt,
        max_tokens = min(768, max(96, len(text) + 64)),
        sampler    = make_sampler(temp=0.0),
    )

    out = re.sub(r"<think>.*?</think>", "", out, flags=re.DOTALL)

    return {"text": out.strip()}


# Kokoro speaks one language per voice pack: language code and a default voice.
KOKORO = {
    "en": ("a", "af_heart"), "es": ("e", "ef_dora"), "fr": ("f", "ff_siwis"), "hi": ("h", "hf_alpha"),
    "it": ("i", "if_sara"),  "ja": ("j", "jf_alpha"), "pt": ("p", "pf_dora"), "zh": ("z", "zf_xiaoxiao"),
}


def load_tts_mlx(req):
    from pathlib import Path
    from mlx_audio.tts.utils import load_model

    place     = mlx_place(req.get("device"))
    model_dir = req["model_dir"]
    parts     = repo_name_parts(model_dir)

    STATE.pop("tts", None)
    gc.collect()

    model = load_model(Path(model_dir), model_name_parts=parts)

    STATE["tts"] = {
        "kind"   : "mlx_audio",
        "model"  : model,
        "kokoro" : "kokoro" in parts,
        "lang"   : req.get("lang") or "en",
    }

    return {"device": place}


def speak_mlx(entry, text):
    model  = entry["model"]
    kwargs = {}

    if entry["kokoro"]:
        code, voice = KOKORO.get(entry["lang"], KOKORO["en"])
        kwargs.update(lang_code=code, voice=voice)

    pieces, rate = [], 24000

    for result in model.generate(text=text, **kwargs):
        pieces.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
        rate = int(getattr(result, "sample_rate", rate) or rate)

    audio = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)

    return audio, rate


# Operations -----------------------------------------------------------------

def mlx_available():
    try:
        import mlx.core as mx

        return bool(mx.metal.is_available())
    except Exception:  # noqa: BLE001 - MLX is optional
        return False


@op("hello")
def hello(req):
    return {
        "torch": torch.__version__,
        "cuda": bool(torch.cuda.is_available()),
        "mps": bool(torch.backends.mps.is_available()),
        "mlx": mlx_available(),
    }


@op("load_stt")
def load_stt(req):
    if req.get("engine") == "mlx":
        return load_stt_mlx(req)

    device = pick_device(req.get("device"))
    pipe   = make_pipeline("automatic-speech-recognition", req["model_dir"], device)

    STATE["stt"]         = pipe
    STATE["stt_whisper"] = getattr(pipe.model.config, "model_type", "") == "whisper"

    return {"device": device_label(device)}


@op("transcribe")
def transcribe(req):
    pipe  = STATE["stt"]
    audio = decode_pcm(req["pcm"])

    if audio.size == 0 or float(np.sqrt(np.mean(audio * audio))) < 1e-4:
        return {"text": ""}

    if isinstance(pipe, dict):
        return transcribe_mlx(pipe, audio, req.get("lang", "auto"))

    kwargs = {}

    if STATE["stt_whisper"]:
        kwargs["task"] = "transcribe"

        if req.get("lang", "auto") != "auto":
            kwargs["language"] = req["lang"]

    sample = {"raw": audio, "sampling_rate": SAMPLE_RATE}

    with no_grad():
        out = pipe(sample, generate_kwargs=kwargs) if kwargs else pipe(sample)

    return {"text": (out.get("text") or "").strip()}


@op("load_mt")
def load_mt(req):
    if req.get("engine") == "mlx":
        return load_mt_mlx(req)

    from transformers import AutoConfig, AutoModelForSeq2SeqLM, AutoTokenizer

    device    = pick_device(req.get("device"))
    model_dir = req["model_dir"]

    config = AutoConfig.from_pretrained(model_dir)
    tok    = AutoTokenizer.from_pretrained(model_dir)
    model  = AutoModelForSeq2SeqLM.from_pretrained(model_dir, dtype=dtype_for(device)) \
        if _accepts_dtype() else AutoModelForSeq2SeqLM.from_pretrained(model_dir, torch_dtype=dtype_for(device))

    model = model.to(device).eval()

    cls   = type(tok).__name__.lower()
    mtype = getattr(config, "model_type", "")

    if "nllb" in cls:
        kind = "nllb"
    elif mtype == "m2m_100":
        kind = "m2m"
    elif mtype == "mbart":
        kind = "mbart"
    elif mtype in ("t5", "mt5", "umt5"):
        kind = "t5"
    else:
        kind = "plain"

    # A slot lets two translation models be loaded at once (pivot through English).
    STATE["mt:" + req.get("slot", "mt")] = {
        "tok": tok, "model": model, "device": device, "kind": kind,
        "src": req["src"], "tgt": req["tgt"],
    }

    return {"device": device_label(device), "kind": kind}


def _accepts_dtype():
    import transformers
    parts = transformers.__version__.split(".")

    try:
        return (int(parts[0]), int(parts[1])) >= (4, 56)
    except ValueError:
        return False


@op("translate")
def translate(req):
    mt = STATE["mt:" + req.get("slot", "mt")]

    if mt["kind"] == "mlx_lm":
        return translate_mlx(mt, req["text"])

    tok, model, device, kind = mt["tok"], mt["model"], mt["device"], mt["kind"]
    src, tgt = mt["src"], mt["tgt"]
    text     = req["text"]
    extra    = {}

    if src == "auto":
        raise ValueError("Automatic language detection needs the cloud translation backend")

    if kind == "nllb":
        tok.src_lang = code_for(FLORES, src, "NLLB")
        extra["forced_bos_token_id"] = tok.convert_tokens_to_ids(code_for(FLORES, tgt, "NLLB"))
    elif kind == "m2m":
        tok.src_lang = src
        extra["forced_bos_token_id"] = tok.get_lang_id(tgt)
    elif kind == "mbart":
        tok.src_lang = code_for(MBART, src, "mBART")
        extra["forced_bos_token_id"] = tok.lang_code_to_id[code_for(MBART, tgt, "mBART")]
    elif kind == "t5":
        text = f"translate {src} to {tgt}: {text}"

    enc = tok(text, return_tensors="pt", truncation=True, max_length=512)
    enc = {k: v.to(device) for k, v in enc.items()}

    with no_grad():
        out = model.generate(**enc, num_beams=2, max_new_tokens=256, **extra)

    return {"text": tok.batch_decode(out, skip_special_tokens=True)[0].strip()}


@op("load_tts")
def load_tts(req):
    if req.get("engine") == "mlx":
        return load_tts_mlx(req)

    device = pick_device(req.get("device"))
    # Many speech synthesis models are fragile in half precision.
    from transformers import pipeline

    STATE["tts"] = pipeline("text-to-speech", model=req["model_dir"], device=device)

    return {"device": device_label(device)}


@op("speak")
def speak(req):
    tts = STATE["tts"]

    if isinstance(tts, dict):
        audio, rate = speak_mlx(tts, req["text"])
    else:
        out   = tts(req["text"])
        audio = np.asarray(out["audio"], dtype=np.float32).squeeze()
        rate  = int(out["sampling_rate"])

    pcm16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")

    buf = io.BytesIO()

    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm16.tobytes())

    return {"wav": base64.b64encode(buf.getvalue()).decode("ascii"), "seconds": float(audio.size) / rate}


@op("load_embed")
def load_embed(req):
    from transformers import AutoFeatureExtractor, AutoModelForAudioXVector

    device = pick_device(req.get("device"))

    STATE["embed"] = {
        "fe"     : AutoFeatureExtractor.from_pretrained(req["model_dir"]),
        "model"  : AutoModelForAudioXVector.from_pretrained(req["model_dir"]).to(device).eval(),
        "device" : device,
    }

    return {"device": device_label(device)}


@op("embed")
def embed(req):
    emb   = STATE["embed"]
    audio = decode_pcm(req["pcm"])

    inputs = emb["fe"](audio, sampling_rate=SAMPLE_RATE, return_tensors="pt", padding=True)
    inputs = {k: v.to(emb["device"]) for k, v in inputs.items()}

    with no_grad():
        vector = emb["model"](**inputs).embeddings
        vector = torch.nn.functional.normalize(vector, dim=-1)[0]

    return {"vector": vector.cpu().tolist()}


@op("load_vad")
def load_vad(req):
    from silero_vad import load_silero_vad

    STATE["vad_factory"] = load_silero_vad
    STATE["vads"]        = {}

    return {}


@op("vad")
def vad(req):
    streams = STATE["vads"]
    stream  = req["stream"]

    if stream not in streams:
        streams[stream] = STATE["vad_factory"]()

    model = streams[stream]
    pcm   = decode_pcm(req["pcm"])
    probs = []

    with no_grad():
        for start in range(0, len(pcm) - 511, 512):
            chunk = torch.from_numpy(pcm[start:start + 512])
            probs.append(float(model(chunk, SAMPLE_RATE).item()))

    return {"probs": probs}


@op("unload")
def unload(req):
    STATE.clear()
    gc.collect()
    gc.collect()

    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:  # noqa: BLE001 - MLX is optional
        pass

    return {}


# MLX keeps its GPU streams per thread, and Rust calls in from several threads, so
# every MLX operation runs on this one thread: loading, generating and freeing.
_MLX_POOL = None


def _runs_on_mlx(name, req):
    if name == "unload":
        return True

    if name in ("load_stt", "load_mt", "load_tts"):
        return req.get("engine") == "mlx"

    key = {"transcribe": "stt", "speak": "tts", "translate": "mt:" + req.get("slot", "mt")}.get(name)

    entry = STATE.get(key) if key else None

    return isinstance(entry, dict) and str(entry.get("kind", "")).startswith("mlx")


def _call_op(name, req):
    global _MLX_POOL

    if not _runs_on_mlx(name, req):
        return OPS[name](req)

    if _MLX_POOL is None:
        from concurrent.futures import ThreadPoolExecutor

        _MLX_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")

    return _MLX_POOL.submit(OPS[name], req).result()


def dispatch(name, args_json, pcm=None):
    """Single entry point called from Rust. Never raises: errors come back as JSON."""
    try:
        req = json.loads(args_json) if args_json else {}

        if pcm is not None:
            req["pcm"] = bytes(pcm)

        result = _call_op(name, req) or {}

        return json.dumps({"ok": True, **result})
    except Exception as err:  # noqa: BLE001 - report every failure to the app
        traceback.print_exc()

        return json.dumps({"error": f"{type(err).__name__}: {err}"})
