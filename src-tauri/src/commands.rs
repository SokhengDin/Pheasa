use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::audio::devices::{self, AudioDeviceInfo};
use crate::compute::{self, ComputeDevice};
use crate::diarize::enroll;
use crate::diarize::voices::{VoiceInfo, VoiceStore};
use crate::engine::{self, Control};
use crate::models::{self, hub, Backend, ModelMeta, Task};
use crate::runtime::{self, RuntimeStatus};
use crate::sessions::{self, Session, SessionInfo};
use crate::settings::Settings;
use crate::state::AppState;

fn describe(err: anyhow::Error) -> String {
    format!("{err:#}")
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().clone()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    settings.save(&state.settings_path).map_err(describe)?;
    *state.settings.lock() = settings;

    Ok(())
}

#[tauri::command]
pub fn list_compute_devices() -> Vec<ComputeDevice> {
    compute::list()
}

#[tauri::command]
pub async fn list_audio_devices() -> Vec<AudioDeviceInfo> {
    devices::list_devices()
}

// Engine -------------------------------------------------------------------

#[tauri::command]
pub async fn start_engine(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.engine.lock().is_some() {
        return Err("The translator is already running".into());
    }

    if state.runtime_busy.load(Ordering::Relaxed) {
        return Err("The Python runtime is being changed. Wait for it to finish".into());
    }

    // The level test and the engine must not both own the audio devices.
    stop_monitor_inner(&state).await;

    let settings = state.settings.lock().clone();
    let data_dir = state.data_dir.clone();
    let job_app  = app.clone();

    let started = tauri::async_runtime::spawn_blocking(move || engine::start(job_app, data_dir, settings))
        .await
        .map_err(|err| err.to_string())?;

    match started {
        Ok(handle) => {
            *state.engine.lock() = Some(handle);
            Ok(())
        }
        Err(err) => {
            let message = describe(err);
            engine::emit_status(&app, "error", &message, "");

            // A failed start may have loaded some models already.
            let _ = tauri::async_runtime::spawn_blocking(runtime::release).await;

            Err(message)
        }
    }
}

#[tauri::command]
pub async fn stop_engine(state: State<'_, AppState>) -> Result<(), String> {
    let handle = state.engine.lock().take();

    if let Some(handle) = handle {
        tauri::async_runtime::spawn_blocking(move || handle.stop())
            .await
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn engine_running(state: State<'_, AppState>) -> bool {
    state.engine.lock().is_some()
}

async fn stop_monitor_inner(state: &AppState) {
    let handle = state.monitor.lock().take();

    if let Some(handle) = handle {
        let _ = tauri::async_runtime::spawn_blocking(move || handle.stop()).await;
    }
}

/// Opens the audio inputs and streams `audio-level` events, without
/// transcribing. Used by the setup wizard and the Settings level test.
#[tauri::command]
pub async fn start_monitor(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.engine.lock().is_some() {
        return Err("The translator is running, so the levels are already live".into());
    }

    stop_monitor_inner(&state).await;

    let settings = state.settings.lock().clone();

    let handle = tauri::async_runtime::spawn_blocking(move || engine::start_monitor(app, settings))
        .await
        .map_err(|err| err.to_string())?
        .map_err(describe)?;

    *state.monitor.lock() = Some(handle);

    Ok(())
}

#[tauri::command]
pub async fn stop_monitor(state: State<'_, AppState>) -> Result<(), String> {
    stop_monitor_inner(&state).await;

    Ok(())
}

// Voices -------------------------------------------------------------------

#[tauri::command]
pub fn list_voices(state: State<'_, AppState>) -> Vec<VoiceInfo> {
    VoiceStore::load(&state.data_dir).infos()
}

/// Tells a running translator that the saved voices changed.
fn voices_changed(state: &AppState) {
    if let Some(control) = state.engine.lock().as_ref().and_then(|handle| handle.control()) {
        let _ = control.send(Control::ReloadVoices);
    }
}

#[tauri::command]
pub fn delete_voice(state: State<'_, AppState>, id: String) -> Result<(), String> {
    VoiceStore::load(&state.data_dir).remove(&id).map_err(describe)?;
    voices_changed(&state);

    Ok(())
}

#[tauri::command]
pub fn rename_voice(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    VoiceStore::load(&state.data_dir).rename(&id, &name).map_err(describe)?;
    voices_changed(&state);

    Ok(())
}

/// Records the microphone for a few seconds and saves the voice under `name`.
#[tauri::command]
pub async fn enroll_voice(state: State<'_, AppState>, name: String, seconds: u32) -> Result<VoiceInfo, String> {
    if state.engine.lock().is_some() {
        return Err("Stop translating first: recording a voice needs the microphone and the speaker model".into());
    }

    if state.runtime_busy.load(Ordering::Relaxed) {
        return Err("The Python runtime is being changed. Wait for it to finish".into());
    }

    stop_monitor_inner(&state).await;

    let settings = state.settings.lock().clone();
    let data_dir = state.data_dir.clone();

    let profile = tauri::async_runtime::spawn_blocking(move || enroll::enroll_from_mic(&data_dir, &settings, &name, seconds))
        .await
        .map_err(|err| err.to_string())?
        .map_err(describe)?;

    Ok(VoiceInfo::from(&profile))
}

/// Saves the voice of an unknown speaker ("Speaker B") heard in the running meeting.
#[tauri::command]
pub async fn remember_voice(state: State<'_, AppState>, label: String, name: String) -> Result<String, String> {
    let control = state
        .engine
        .lock()
        .as_ref()
        .and_then(|handle| handle.control())
        .ok_or_else(|| "Start the translator first: the voice is taken from the running meeting".to_string())?;

    let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);

    control
        .send(Control::Remember { label, name, reply: reply_tx })
        .map_err(|_| "The translator has stopped".to_string())?;

    let answer = tauri::async_runtime::spawn_blocking(move || reply_rx.recv_timeout(Duration::from_secs(30)))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|_| "The translator did not answer in time".to_string())?;

    answer
}

// Models -------------------------------------------------------------------

#[tauri::command]
pub async fn search_models(
    state : State<'_, AppState>,
    task  : Task,
    query : String,
    tag   : Option<String>,
) -> Result<Vec<hub::ModelCard>, String> {
    hub::search(task, &query, tag.as_deref().unwrap_or(""), &state.models_dir())
        .await
        .map_err(describe)
}

#[tauri::command]
pub async fn recommended_models(
    state : State<'_, AppState>,
    task  : Task,
    src   : String,
    tgt   : String,
) -> Result<Vec<hub::Recommendation>, String> {
    Ok(hub::recommended(task, &src, &tgt, &state.models_dir()).await)
}

#[tauri::command]
pub async fn download_model(
    app     : AppHandle,
    state   : State<'_, AppState>,
    id      : String,
    task    : Task,
    backend : Backend,
) -> Result<(), String> {
    if backend.needs_python() && !runtime::is_ready(&state.data_dir) {
        return Err("This model runs on the Python runtime. Set it up in Storage first".into());
    }

    if backend == Backend::Mlx && !models::MLX_SUPPORTED {
        return Err("MLX models need a Mac with Apple silicon".into());
    }

    if state.downloads.lock().contains_key(&id) {
        return Err("This model is already downloading".into());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    state.downloads.lock().insert(id.clone(), cancel.clone());

    let result = hub::download(&app, &state.models_dir(), &id, task, backend, cancel).await;

    state.downloads.lock().remove(&id);

    result.map_err(describe)
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, id: String) {
    if let Some(flag) = state.downloads.lock().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn list_installed(state: State<'_, AppState>, task: Option<Task>) -> Vec<ModelMeta> {
    models::list_installed(&state.models_dir(), task)
}

/// Removes the model folder completely. Refused while the translator runs
/// (the files are in use) or while the model is still downloading. Any setting
/// that pointed at the model is cleared. Returns the updated settings.
#[tauri::command]
pub fn delete_model(state: State<'_, AppState>, id: String, task: Task) -> Result<Settings, String> {
    if state.engine.lock().is_some() {
        return Err("Stop the translator before deleting a model".into());
    }

    if state.downloads.lock().contains_key(&id) {
        return Err("Cancel the download first".into());
    }

    models::delete(&state.models_dir(), task, &id).map_err(describe)?;

    let mut settings = state.settings.lock();
    let clear = |slot: &mut Option<String>| {
        if slot.as_deref() == Some(id.as_str()) {
            *slot = None;
        }
    };

    match task {
        Task::Stt         => clear(&mut settings.stt_model),
        Task::Translation => {
            clear(&mut settings.mt_model);
            clear(&mut settings.mt_model_2);
        }
        Task::Tts         => clear(&mut settings.tts_model),
        Task::Speaker     => clear(&mut settings.speaker_model),
    }

    settings.save(&state.settings_path).map_err(describe)?;

    Ok(settings.clone())
}

// Python runtime -----------------------------------------------------------

#[tauri::command]
pub fn runtime_status(state: State<'_, AppState>) -> RuntimeStatus {
    runtime::status(&state.data_dir)
}

#[tauri::command]
pub async fn setup_runtime(
    app    : AppHandle,
    state  : State<'_, AppState>,
    flavor : String,
) -> Result<RuntimeStatus, String> {
    if state.runtime_busy.swap(true, Ordering::SeqCst) {
        return Err("The Python runtime is already being changed".into());
    }

    let data_dir = state.data_dir.clone();
    let job_dir  = data_dir.clone();

    let result = tauri::async_runtime::spawn_blocking(move || runtime::setup(&app, &job_dir, &flavor)).await;

    state.runtime_busy.store(false, Ordering::SeqCst);

    result.map_err(|err| err.to_string())?.map_err(describe)?;

    Ok(runtime::status(&data_dir))
}

/// Adds the MLX packages (Apple GPU) to a runtime that was set up without them.
#[tauri::command]
pub async fn add_mlx_runtime(app: AppHandle, state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    if state.engine.lock().is_some() {
        return Err("Stop the translator before changing the runtime".into());
    }

    if state.runtime_busy.swap(true, Ordering::SeqCst) {
        return Err("The Python runtime is already being changed".into());
    }

    let data_dir = state.data_dir.clone();
    let job_dir  = data_dir.clone();

    let result = tauri::async_runtime::spawn_blocking(move || runtime::add_mlx(&app, &job_dir)).await;

    state.runtime_busy.store(false, Ordering::SeqCst);

    result.map_err(|err| err.to_string())?.map_err(describe)?;

    Ok(runtime::status(&data_dir))
}

/// Deletes the whole runtime (environment, packages, caches). On Windows a
/// loaded library can lock files; then deletion is queued for the next start.
#[tauri::command]
pub async fn remove_runtime(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    if state.engine.lock().is_some() {
        return Err("Stop the translator before removing the runtime".into());
    }

    if state.runtime_busy.swap(true, Ordering::SeqCst) {
        return Err("The Python runtime is already being changed".into());
    }

    stop_monitor_inner(&state).await;

    let data_dir = state.data_dir.clone();
    let job_dir  = data_dir.clone();

    let result = tauri::async_runtime::spawn_blocking(move || runtime::remove(&job_dir)).await;

    state.runtime_busy.store(false, Ordering::SeqCst);

    result.map_err(|err| err.to_string())?.map_err(describe)?;

    Ok(runtime::status(&data_dir))
}

// Storage ------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct StorageReport {
    pub models        : Vec<ModelMeta>,
    pub models_bytes  : u64,
    pub runtime       : RuntimeStatus,
    pub sessions_bytes: u64,
    pub total_bytes   : u64,
    pub path          : String,
}

#[tauri::command]
pub fn storage_report(state: State<'_, AppState>) -> StorageReport {
    let installed    = models::list_installed(&state.models_dir(), None);
    let models_bytes = models::tree_size(&state.models_dir());
    let runtime      = runtime::status(&state.data_dir);
    let sessions     = sessions::size(&state.data_dir);

    StorageReport {
        models         : installed,
        models_bytes,
        total_bytes    : models_bytes + runtime.size_bytes + sessions,
        runtime,
        sessions_bytes : sessions,
        path           : state.data_dir.display().to_string(),
    }
}

/// Opens the app's data folder in Finder, Explorer or the file manager.
#[tauri::command]
pub fn reveal_data_dir(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.data_dir.clone();

    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };

    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("cannot open {}: {err}", dir.display()))
}

// Sessions -----------------------------------------------------------------

#[tauri::command]
pub fn save_session(
    state       : State<'_, AppState>,
    title       : String,
    source_lang : String,
    target_lang : String,
    entries     : Vec<Value>,
) -> Result<u64, String> {
    sessions::save(&state.data_dir, title, source_lang, target_lang, entries).map_err(describe)
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>, query: String) -> Vec<SessionInfo> {
    sessions::list(&state.data_dir, &query)
}

#[tauri::command]
pub fn load_session(state: State<'_, AppState>, id: u64) -> Result<Session, String> {
    sessions::load(&state.data_dir, id).map_err(describe)
}

#[tauri::command]
pub fn delete_session(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    sessions::delete(&state.data_dir, id).map_err(describe)
}

#[tauri::command]
pub fn clear_sessions(state: State<'_, AppState>) -> Result<(), String> {
    sessions::clear(&state.data_dir).map_err(describe)
}

// Files and windows ----------------------------------------------------------

/// Opens the system "save as" dialog and writes the text file. Returns the
/// chosen path, or None when the person cancels.
#[tauri::command]
pub async fn save_text_file(
    app            : AppHandle,
    suggested_name : String,
    extension      : String,
    content        : String,
) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&suggested_name)
            .add_filter("Transcript", &[extension.as_str()])
            .blocking_save_file()
    })
    .await
    .map_err(|err| err.to_string())?;

    let Some(file) = picked else { return Ok(None) };

    let path = file.into_path().map_err(|err| err.to_string())?;

    std::fs::write(&path, content).map_err(|err| err.to_string())?;

    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub fn set_overlay(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "The subtitle window is missing".to_string())?;

    if visible {
        window.show().map_err(|err| err.to_string())
    } else {
        window.hide().map_err(|err| err.to_string())
    }
}
