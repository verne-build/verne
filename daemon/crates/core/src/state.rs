use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use crate::services::agent_shadow::AgentShadow;
use crate::services::git_worker::GitRepoHandle;
use crate::services::session_manager::SessionManager;
use crate::services::shadow_tree::ShadowTree;
use crate::settings::SettingsManager;

/// One live FFF picker per directory, shared by file + content search. Holds a
/// `SharedFilePicker` whose background scan + fs watcher keep the index fresh;
/// dropping it cancels those threads.
pub struct DirPickerCache {
    pub picker: fff_search::SharedFilePicker,
}

/// Broadcast bus for daemon-pushed events. Subscribers connect via
/// `__subscribe_events` and receive `protocol::Event` frames.
pub struct EventBus(tokio::sync::broadcast::Sender<crate::protocol::Event>);

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(1024);
        Self(tx)
    }
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<crate::protocol::Event> {
        self.0.subscribe()
    }
    pub fn emit(&self, name: &str, payload: serde_json::Value) {
        let _ = self.0.send(crate::protocol::Event {
            name: name.into(),
            payload,
        });
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AppState {
    pub sessions: Arc<Mutex<SessionManager>>,
    pub settings: Arc<SettingsManager>,
    pub ws_port: u16,
    pub resource_dir: PathBuf,
    pub file_watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
    pub shadow_trees: Mutex<HashMap<String, ShadowTree>>,
    pub agent_shadows: Arc<Mutex<HashMap<String, AgentShadow>>>,
    pub internal_data_dir: PathBuf,
    /// One FFF picker per directory, shared by file + content search.
    pub picker_cache: Arc<Mutex<HashMap<String, DirPickerCache>>>,
    /// Global frecency tracker (LMDB, keyed by absolute path). Applied to every
    /// picker's files during its background scan; recency boost is 0 if open fails.
    pub frecency: fff_search::SharedFrecency,
    pub git_watchers: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    pub git_workers: Mutex<HashMap<String, GitRepoHandle>>,
    pub source_control_visible: Arc<AtomicBool>,
    pub home_dir: PathBuf,
    pub node_path: Option<PathBuf>,
    pub emitter: Mutex<Option<crate::emitter::Emitter>>,
    pub event_bus: Arc<EventBus>,
    /// Hook server port (Phase 6 test harness reads this via __debug_hook_port).
    /// 0 until the hook server binds.
    pub hook_port: AtomicU16,
    /// Per-launch secret embedded in notify.sh. Tests read it via
    /// __debug_hook_secret to forge valid hook requests. Empty until the
    /// hook server starts.
    pub hook_secret: Mutex<String>,
}

/// State retained in the persistent `verne --server` daemon. The daemon's
/// raison d'être is PTY persistence across host restarts — anything not
/// strictly required to keep PTYs alive belongs in the sidecar (workspace
/// filesystem) or Electron (app state); the daemon is deliberately DB-free.
#[allow(dead_code)]
pub struct DaemonState {
    pub sessions: Arc<Mutex<SessionManager>>,
    pub ws_port: u16,
    pub event_bus: Arc<EventBus>,
    /// Per-launch secret baked into notify.sh by Electron. The daemon embeds it
    /// in all hook requests and rejects requests that don't present it.
    pub hook_secret: std::sync::Mutex<String>,
    /// Actual port the hook HTTP listener bound to. 0 until bound.
    pub hook_port: std::sync::atomic::AtomicU16,
}

#[allow(dead_code)]
impl DaemonState {
    pub fn new(ws_port: u16) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(SessionManager::new())),
            ws_port,
            event_bus: Arc::new(EventBus::new()),
            hook_secret: std::sync::Mutex::new(load_or_create_hook_secret()),
            hook_port: std::sync::atomic::AtomicU16::new(0),
        }
    }
}

/// Read the persisted hook secret, or mint one and write it (0600). Stable
/// across daemon restarts so notify.sh never desyncs when the detached daemon is
/// restarted out-of-band of Electron — a stale secret silently 403s every hook.
fn load_or_create_hook_secret() -> String {
    let path = crate::paths::hook_secret_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim();
        if !s.is_empty() {
            return s.to_string();
        }
    }
    let secret = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&path, &secret).is_ok() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    secret
}

impl AppState {
    pub fn new(
        ws_port: u16,
        resource_dir: PathBuf,
        internal_data_dir: PathBuf,
        home_dir: PathBuf,
        node_path: Option<PathBuf>,
    ) -> Self {
        let frecency = fff_search::SharedFrecency::default();
        if let Ok(tracker) =
            fff_search::frecency::FrecencyTracker::open(internal_data_dir.join("fff-frecency"))
        {
            let _ = frecency.init(tracker);
        }
        Self {
            sessions: Arc::new(Mutex::new(SessionManager::new())),
            settings: Arc::new(SettingsManager::new()),
            ws_port,
            resource_dir: resource_dir.clone(),
            file_watchers: Mutex::new(HashMap::new()),
            shadow_trees: Mutex::new(HashMap::new()),
            agent_shadows: Arc::new(Mutex::new(HashMap::new())),
            internal_data_dir,
            picker_cache: Arc::new(Mutex::new(HashMap::new())),
            frecency,
            git_watchers: Arc::new(Mutex::new(HashMap::new())),
            git_workers: Mutex::new(HashMap::new()),
            source_control_visible: Arc::new(AtomicBool::new(false)),
            home_dir,
            node_path,
            emitter: Mutex::new(None),
            event_bus: Arc::new(EventBus::new()),
            hook_port: AtomicU16::new(0),
            hook_secret: Mutex::new(String::new()),
        }
    }

    /// Tear down watchers/workers/shadow trees for a removed directory subtree.
    /// Electron owns the directory rows now and forwards this (with the pre-delete
    /// snapshot) so the sidecar releases the subtree's in-memory resources.
    pub fn evict_directory_resources(&self, id: &str, all_dirs: &[crate::types::WorkingDirectory]) {
        use std::collections::HashSet;
        let mut victim_ids: HashSet<&str> = HashSet::new();
        victim_ids.insert(id);
        loop {
            let before = victim_ids.len();
            for d in all_dirs {
                if let Some(pid) = d.parent_directory_id.as_deref() {
                    if victim_ids.contains(pid) {
                        victim_ids.insert(d.id.as_str());
                    }
                }
            }
            if victim_ids.len() == before {
                break;
            }
        }
        let victim_paths: Vec<&str> = all_dirs
            .iter()
            .filter(|d| victim_ids.contains(d.id.as_str()))
            .map(|d| d.path.as_str())
            .collect();
        let surviving_repo_keys: HashSet<String> = all_dirs
            .iter()
            .filter(|d| !victim_ids.contains(d.id.as_str()))
            .map(|d| crate::services::git::repo_key(&d.path))
            .collect();

        if let Ok(mut watchers) = self.git_watchers.lock() {
            for p in &victim_paths {
                if let Some(stop) = watchers.remove(*p) {
                    stop.store(true, Ordering::Relaxed);
                }
            }
        }
        if let Ok(mut trees) = self.shadow_trees.lock() {
            for p in &victim_paths {
                trees.remove(*p);
            }
        }
        if let Ok(mut cache) = self.picker_cache.lock() {
            for p in &victim_paths {
                cache.remove(*p);
            }
        }
        if let Ok(mut watchers) = self.file_watchers.lock() {
            for p in &victim_paths {
                watchers.remove(*p);
                watchers.remove(&format!("dir:{}", p));
                let prefix = format!("{}/", p);
                let dir_prefix = format!("dir:{}/", p);
                watchers.retain(|k, _| !(k.starts_with(&prefix) || k.starts_with(&dir_prefix)));
            }
        }
        if let Ok(mut workers) = self.git_workers.lock() {
            for p in &victim_paths {
                let key = crate::services::git::repo_key(p);
                if !surviving_repo_keys.contains(&key) {
                    workers.remove(&key);
                }
            }
        }
    }
}
