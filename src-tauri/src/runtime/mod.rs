//! Embedded Python, through PyO3.
//!
//! The interpreter runs inside this process. Packages (torch, transformers)
//! live in a private virtual environment in the app data folder, which is
//! created and filled by `setup`, and deleted completely by `remove`. Models
//! are loaded only from the app's own model folders, with the Hugging Face
//! offline switches on, so nothing is cached anywhere else on the disk.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;

use anyhow::{anyhow, bail, Context, Result};
use pyo3::ffi::c_str;
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::models::{tree_size, MLX_SUPPORTED};

static MODULE: OnceLock<Py<PyModule>> = OnceLock::new();

pub struct Paths {
    pub root    : PathBuf,
    pub venv    : PathBuf,
    pub cache   : PathBuf,
    pub marker  : PathBuf,
    pub pending : PathBuf,
}

pub fn paths(data_dir: &Path) -> Paths {
    let root = data_dir.join("runtime");

    Paths {
        venv    : root.join("venv"),
        cache   : root.join("cache"),
        marker  : root.join("ready.json"),
        pending : data_dir.join("runtime.remove"),
        root,
    }
}

fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// The folder that holds the installed packages inside the virtual environment.
fn site_packages(venv: &Path) -> Result<PathBuf> {
    if cfg!(windows) {
        return Ok(venv.join("Lib").join("site-packages"));
    }

    let lib = venv.join("lib");

    for entry in fs::read_dir(&lib).with_context(|| format!("reading {}", lib.display()))?.flatten() {
        if entry.file_name().to_string_lossy().starts_with("python") {
            return Ok(entry.path().join("site-packages"));
        }
    }

    bail!("the Python environment is incomplete, set it up again")
}

struct BasePython {
    exe     : PathBuf,
    version : String,
    minor   : String,
}

/// The interpreter this app is linked against. The virtual environment must be
/// built from the same one, otherwise compiled packages would not load.
fn base_python() -> Result<BasePython> {
    let info = Python::attach(|py| -> PyResult<(String, String, String)> {
        let sys    = py.import("sys")?;
        let prefix = sys.getattr("base_prefix")?.extract::<String>()?;
        let info   = sys.getattr("version_info")?;
        let major  = info.getattr("major")?.extract::<u32>()?;
        let minor  = info.getattr("minor")?.extract::<u32>()?;
        let micro  = info.getattr("micro")?.extract::<u32>()?;

        Ok((prefix, format!("{major}.{minor}.{micro}"), format!("{major}.{minor}")))
    })
    .map_err(|err| anyhow!("cannot start the embedded Python: {err}"))?;

    let prefix = PathBuf::from(&info.0);

    let candidates = if cfg!(windows) {
        vec![prefix.join("python.exe")]
    } else {
        vec![
            prefix.join("bin").join(format!("python{}", info.2)),
            prefix.join("bin").join("python3"),
        ]
    };

    let exe = candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| anyhow!("cannot find the Python program under {}", prefix.display()))?;

    Ok(BasePython { exe, version: info.1, minor: info.2 })
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    pub python_version : Option<String>,
    pub ready          : bool,
    pub flavor         : Option<String>,
    /// MLX packages (Apple GPU) are installed in the environment.
    pub mlx            : bool,
    /// This machine can run MLX at all (Apple silicon).
    pub mlx_supported  : bool,
    pub size_bytes     : u64,
    pub removal_queued : bool,
}

pub fn status(data_dir: &Path) -> RuntimeStatus {
    let p     = paths(data_dir);
    let ready = p.marker.exists() && venv_python(&p.venv).exists();

    let marker = fs::read(&p.marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());

    let flavor = marker.as_ref().and_then(|value| value["flavor"].as_str().map(String::from));
    let mlx    = ready && marker.as_ref().is_some_and(|value| value["mlx"].as_bool().unwrap_or(false));

    RuntimeStatus {
        python_version : base_python().ok().map(|b| b.version),
        ready,
        flavor,
        mlx,
        mlx_supported  : MLX_SUPPORTED,
        size_bytes     : tree_size(&p.root),
        removal_queued : p.pending.exists(),
    }
}

pub fn is_ready(data_dir: &Path) -> bool {
    let p = paths(data_dir);

    p.marker.exists() && venv_python(&p.venv).exists()
}

fn quiet(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    #[cfg(not(windows))]
    let _ = cmd;
}

fn log_line(app: &AppHandle, line: &str) {
    let _ = app.emit("runtime-setup", json!({ "line": line, "done": false }));
}

/// Runs a command and streams its output to the UI as it happens.
fn run_logged(app: &AppHandle, mut cmd: Command, cache: &Path) -> Result<()> {
    cmd.env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .env("PIP_NO_CACHE_DIR", "1")
        .env("XDG_CACHE_HOME", cache)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    quiet(&mut cmd);

    let mut child  = cmd.spawn().context("cannot start Python")?;
    let stdout     = child.stdout.take().ok_or_else(|| anyhow!("no output from Python"))?;
    let stderr     = child.stderr.take().ok_or_else(|| anyhow!("no output from Python"))?;

    let out_app = app.clone();
    let err_app = app.clone();

    let out = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            log_line(&out_app, &line);
        }
    });

    let err = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            log_line(&err_app, &line);
        }
    });

    let status = child.wait()?;

    let _ = out.join();
    let _ = err.join();

    if !status.success() {
        bail!("a setup step failed, see the log above");
    }

    Ok(())
}

/// Builds the private environment. Blocking and slow (downloads several GB for
/// torch), so call it from `spawn_blocking`. A failed setup removes everything
/// it created, so no half-installed files stay on the disk.
pub fn setup(app: &AppHandle, data_dir: &Path, flavor: &str) -> Result<()> {
    let result = setup_inner(app, data_dir, flavor);

    if result.is_err() {
        let _ = fs::remove_dir_all(paths(data_dir).root);
    }

    let _ = app.emit(
        "runtime-setup",
        json!({ "line": "", "done": true, "error": result.as_ref().err().map(|e| format!("{e:#}")) }),
    );

    result
}

fn setup_inner(app: &AppHandle, data_dir: &Path, flavor: &str) -> Result<()> {
    let base = base_python()?;
    let p    = paths(data_dir);

    let _ = fs::remove_file(&p.pending);

    if p.root.exists() {
        fs::remove_dir_all(&p.root)?;
    }

    fs::create_dir_all(&p.cache)?;

    log_line(app, &format!("Creating a private Python {} environment", base.version));

    let mut venv = Command::new(&base.exe);
    venv.args(["-m", "venv"]).arg(&p.venv);
    run_logged(app, venv, &p.cache)?;

    let python = venv_python(&p.venv);

    log_line(app, "Installing PyTorch. This is the large download");

    let mut torch = Command::new(&python);
    torch.args(["-m", "pip", "install", "--no-cache-dir", "torch", "torchaudio"]);

    // macOS wheels from PyPI already include Apple GPU (MPS) support, and the
    // CUDA and CPU-only indexes are for Windows and Linux, so Mac always uses PyPI.
    let flavor = if cfg!(target_os = "macos") { "auto" } else { flavor };

    match flavor {
        "cpu"  => { torch.args(["--index-url", "https://download.pytorch.org/whl/cpu"]); }
        "cuda" => { torch.args(["--index-url", "https://download.pytorch.org/whl/cu124"]); }
        _      => {}
    }

    run_logged(app, torch, &p.cache)?;

    log_line(app, "Installing the language packages");

    let mut rest = Command::new(&python);
    rest.args([
        "-m", "pip", "install", "--no-cache-dir",
        "transformers>=4.45", "sentencepiece", "protobuf", "sacremoses", "numpy", "silero-vad",
    ]);
    run_logged(app, rest, &p.cache)?;

    // Apple silicon also gets MLX, which runs Whisper, Parakeet, translation
    // models and voices on the Apple GPU.
    let mlx = if MLX_SUPPORTED {
        install_mlx_packages(app, &python, &p.cache)?;
        true
    } else {
        false
    };

    log_line(app, "Checking the installation");

    let mut check = Command::new(&python);
    check.args(["-c", "import torch, transformers, silero_vad"]);
    run_logged(app, check, &p.cache)?;

    fs::write(
        &p.marker,
        serde_json::to_vec_pretty(&json!({ "flavor": flavor, "python": base.minor, "mlx": mlx }))?,
    )?;

    Ok(())
}

/// The packages that make up the MLX engine. `misaki` is the text front end of
/// the Kokoro voices.
const MLX_PACKAGES: [&str; 5] = ["mlx-lm", "mlx-whisper", "mlx-audio[stt,tts]", "misaki", "numpy"];

fn install_mlx_packages(app: &AppHandle, python: &Path, cache: &Path) -> Result<()> {
    log_line(app, "Installing MLX for the Apple GPU");

    let mut mlx = Command::new(python);
    mlx.args(["-m", "pip", "install", "--no-cache-dir"]).args(MLX_PACKAGES);
    run_logged(app, mlx, cache)?;

    log_line(app, "Checking MLX");

    let mut check = Command::new(python);
    check.args(["-c", "import mlx.core, mlx_lm, mlx_whisper, mlx_audio"]);
    run_logged(app, check, cache)
}

/// Adds MLX to a runtime that was set up without it. Blocking; call it from
/// `spawn_blocking`. A failure leaves the existing runtime as it was.
pub fn add_mlx(app: &AppHandle, data_dir: &Path) -> Result<()> {
    let result = add_mlx_inner(app, data_dir);

    let _ = app.emit(
        "runtime-setup",
        json!({ "line": "", "done": true, "error": result.as_ref().err().map(|e| format!("{e:#}")) }),
    );

    result
}

fn add_mlx_inner(app: &AppHandle, data_dir: &Path) -> Result<()> {
    if !MLX_SUPPORTED {
        bail!("MLX needs a Mac with Apple silicon");
    }

    let p = paths(data_dir);

    if !is_ready(data_dir) {
        bail!("Set up the Python runtime first");
    }

    install_mlx_packages(app, &venv_python(&p.venv), &p.cache)?;

    let mut marker = fs::read(&p.marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({}));

    marker["mlx"] = json!(true);
    fs::write(&p.marker, serde_json::to_vec_pretty(&marker)?)?;

    Ok(())
}

/// True when the MLX packages are installed in the runtime.
pub fn mlx_ready(data_dir: &Path) -> bool {
    status(data_dir).mlx
}

/// Deletes the whole environment. Returns true when it is already gone, false
/// when files are still in use (Windows locks loaded libraries) and the removal
/// was queued for the next start.
pub fn remove(data_dir: &Path) -> Result<bool> {
    let p = paths(data_dir);

    if !p.root.exists() {
        let _ = fs::remove_file(&p.pending);
        return Ok(true);
    }

    match fs::remove_dir_all(&p.root) {
        Ok(()) => {
            let _ = fs::remove_file(&p.pending);
            Ok(true)
        }
        Err(err) => {
            log::warn!("runtime removal postponed: {err}");
            fs::write(&p.pending, b"1")?;
            Ok(false)
        }
    }
}

/// Finishes a removal that was queued, and clears a half-built environment.
pub fn sweep(data_dir: &Path) {
    let p = paths(data_dir);

    if p.pending.exists() || (p.root.exists() && !p.marker.exists()) {
        if fs::remove_dir_all(&p.root).is_ok() || !p.root.exists() {
            let _ = fs::remove_file(&p.pending);
        }
    }
}

/// Starts the interpreter on the private packages and loads the helper module.
/// Safe to call many times.
pub fn ensure_loaded(data_dir: &Path) -> Result<()> {
    if MODULE.get().is_some() {
        return Ok(());
    }

    let p = paths(data_dir);

    if !is_ready(data_dir) {
        bail!("The Python runtime is not set up yet. Open Storage and press Set up");
    }

    let recorded = fs::read(&p.marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["python"].as_str().map(String::from));

    let base = base_python()?;

    if recorded.is_some_and(|version| version != base.minor) {
        bail!("Python was updated since the runtime was installed. Remove it in Storage and set it up again");
    }

    let site    = site_packages(&p.venv)?.to_string_lossy().to_string();
    let exe     = venv_python(&p.venv).to_string_lossy().to_string();
    let cache   = p.cache.to_string_lossy().to_string();
    let torch   = p.cache.join("torch").to_string_lossy().to_string();

    let loaded = Python::attach(|py| -> PyResult<Py<PyModule>> {
        let sys = py.import("sys")?;

        sys.getattr("path")?.call_method1("insert", (0, site))?;
        sys.setattr("dont_write_bytecode", true)?;

        // Inside this process `sys.executable` is the app itself. Libraries that start a
        // helper with it (multiprocessing, torch, transformers) would launch a second copy
        // of the app, so point them at the environment's real Python instead.
        sys.setattr("executable", exe.as_str())?;
        sys.setattr("_base_executable", exe.as_str())?;
        py.import("multiprocessing")?.call_method1("set_executable", (exe.as_str(),))?;

        let environ = py.import("os")?.getattr("environ")?;

        for (key, value) in [
            ("HF_HUB_OFFLINE",           "1"),
            ("TRANSFORMERS_OFFLINE",     "1"),
            ("HF_HOME",                  cache.as_str()),
            ("XDG_CACHE_HOME",           cache.as_str()),
            ("TORCH_HOME",               torch.as_str()),
            ("TOKENIZERS_PARALLELISM",   "false"),
            ("PYTORCH_ENABLE_MPS_FALLBACK", "1"),
        ] {
            environ.set_item(key, value)?;
        }

        let module = PyModule::from_code(
            py,
            c_str!(include_str!("worker.py")),
            c"lt_worker.py",
            c"lt_worker",
        )?;

        Ok(module.unbind())
    })
    .map_err(|err| anyhow!("cannot load the Python runtime: {err}"))?;

    let _ = MODULE.set(loaded);

    Ok(())
}

/// Frees every model the Python side holds (speech, translation, voice, VAD) and
/// hands the memory back. Does nothing when Python was never loaded.
pub fn release() {
    if MODULE.get().is_some() {
        let _ = call("unload", serde_json::json!({}), None);
    }
}

/// Calls one operation of the helper module. `pcm` is sent as raw 16 kHz mono
/// float32 samples.
pub fn call(op: &str, args: Value, pcm: Option<&[f32]>) -> Result<Value> {
    let module = MODULE
        .get()
        .ok_or_else(|| anyhow!("The Python runtime is not loaded"))?;

    let args_json = args.to_string();
    let bytes: Option<Vec<u8>> = pcm.map(|samples| samples.iter().flat_map(|s| s.to_le_bytes()).collect());

    let reply = Python::attach(|py| -> PyResult<String> {
        let raw = bytes.as_deref().map(|b| PyBytes::new(py, b));

        module
            .bind(py)
            .call_method1("dispatch", (op, args_json, raw))?
            .extract::<String>()
    })
    .map_err(|err| anyhow!("Python error: {err}"))?;

    let value: Value = serde_json::from_str(&reply)?;

    if let Some(message) = value["error"].as_str() {
        bail!("{message}");
    }

    Ok(value)
}
