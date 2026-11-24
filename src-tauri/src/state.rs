use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::engine::EngineHandle;
use crate::settings::Settings;

pub struct AppState {
    pub data_dir      : PathBuf,
    pub settings_path : PathBuf,
    pub settings      : Mutex<Settings>,
    pub engine        : Mutex<Option<EngineHandle>>,
    pub monitor       : Mutex<Option<EngineHandle>>,
    pub runtime_busy  : AtomicBool,
    pub downloads     : Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, config_dir: PathBuf) -> Self {
        let settings_path = config_dir.join("settings.json");
        let settings      = Settings::load(&settings_path);

        Self {
            data_dir,
            settings_path,
            settings     : Mutex::new(settings),
            engine       : Mutex::new(None),
            monitor      : Mutex::new(None),
            runtime_busy : AtomicBool::new(false),
            downloads    : Mutex::new(HashMap::new()),
        }
    }

    pub fn models_dir(&self) -> PathBuf {
        self.data_dir.join("models")
    }
}
