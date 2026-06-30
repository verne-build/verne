use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::types::AppSettings;

pub fn settings_path() -> PathBuf {
    let base = std::env::var_os("VERNE_APP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(crate::paths::user_data_dir);
    base.join("settings.json")
}

pub struct SettingsManager {
    cache: Mutex<Option<AppSettings>>,
}

pub fn load_from_disk() -> AppSettings {
    match fs::read_to_string(settings_path()) {
        Ok(json) => {
            // Migrate legacy keys before deserialization. Unknown top-level
            // keys land in the flattened `language_overrides` HashMap and
            // their value must shape-match LanguageOverrideSettings, so any
            // legacy scalar field left in settings.json blows up the entire
            // deserialize unless stripped here.
            let mut v: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
            if let Some(obj) = v.as_object_mut() {
                obj.remove("dangerouslySkipPermissions");
                obj.remove("autoApproveByDefault");
                obj.remove("uiMode");
                obj.remove("defaultFormatter");
                obj.remove("formatOnSave");
                obj.remove("aiProvider");
                obj.remove("openaiApiKey");
                obj.remove("githubCopilotToken");

                if obj.contains_key("reviewAgent") {
                    let v = obj.remove("reviewAgent");
                    if !obj.contains_key("defaultAgent") {
                        if let Some(v) = v { obj.insert("defaultAgent".into(), v); }
                    }
                }

                // theme → appearance/darkTheme/lightTheme. Gated on `appearance`
                // absence so re-running on already-migrated settings is a no-op.
                if !obj.contains_key("appearance") {
                    let legacy = obj
                        .remove("theme")
                        .and_then(|v| v.as_str().map(|s| s.to_string()));
                    let dark = match legacy.as_deref() {
                        Some("sovngarde") | None => "default-dark".to_string(),
                        Some(other) => other.to_string(),
                    };
                    obj.insert("appearance".into(), serde_json::Value::String("dark".into()));
                    obj.insert("darkTheme".into(), serde_json::Value::String(dark));
                    obj.insert("lightTheme".into(), serde_json::Value::Null);
                } else {
                    obj.remove("theme");
                }
            }
            deserialize_lenient(v)
        }
        Err(_) => AppSettings::default(),
    }
}

/// Deserialize an `AppSettings` value tolerantly. A stray/legacy/unknown
/// top-level key lands in the flattened `language_overrides` map and, unless its
/// value shape-matches `LanguageOverrideSettings`, fails the WHOLE deserialize —
/// which would silently reset every user setting. On failure we drop only the
/// genuinely-incompatible unknown keys and retry, preserving every real setting.
/// Shared by `load_from_disk` and the `set_config` RPC so a renderer that adds a
/// new setting the backend doesn't know about can't break the config push.
pub fn deserialize_lenient(mut v: serde_json::Value) -> AppSettings {
    match serde_json::from_value::<AppSettings>(v.clone()) {
        Ok(s) => s,
        Err(first_err) => {
            log::warn!("settings parse failed ({first_err}); stripping incompatible unknown keys");
            let known = known_top_level_keys();
            if let Some(obj) = v.as_object_mut() {
                obj.retain(|k, val| {
                    known.contains(k)
                        || serde_json::from_value::<crate::types::LanguageOverrideSettings>(
                            val.clone(),
                        )
                        .is_ok()
                });
            }
            serde_json::from_value::<AppSettings>(v).unwrap_or_else(|e| {
                log::error!("settings unparseable after sanitize: {e}; using defaults");
                AppSettings::default()
            })
        }
    }
}

/// Recognized top-level setting keys (camelCase), derived from the struct so
/// the list can't drift. Optional fields are forced to `Some` so their keys
/// appear even though they're `skip_serializing_if = Option::is_none`.
fn known_top_level_keys() -> std::collections::HashSet<String> {
    let mut probe = AppSettings::default();
    probe.default_editor = Some(String::new());
    probe.directory_editors = Some(Default::default());
    probe.directory_agent_types = Some(Default::default());
    probe.worktrees_root = Some(String::new());
    probe.voice = Some(Default::default());
    match serde_json::to_value(&probe) {
        Ok(serde_json::Value::Object(m)) => m.keys().cloned().collect(),
        _ => std::collections::HashSet::new(),
    }
}

impl SettingsManager {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(None),
        }
    }

    pub fn invalidate(&self) {
        *self.cache.lock().unwrap() = None;
    }

    /// Replace the cached settings wholesale. Used by the `set_config` RPC so
    /// Electron (the owner of settings.json) can push the current values without
    /// the sidecar reading the file. No disk write.
    pub fn set_cache(&self, settings: AppSettings) {
        *self.cache.lock().unwrap() = Some(settings);
    }

    pub fn get(&self) -> AppSettings {
        let mut cache = self.cache.lock().unwrap();
        if let Some(ref s) = *cache {
            return s.clone();
        }
        let settings = load_from_disk();
        *cache = Some(settings.clone());
        settings
    }

    pub fn update(&self, partial: &serde_json::Value) -> AppSettings {
        // Hold the cache mutex across the entire read-modify-write so concurrent
        // updates can't both snapshot the same base and clobber each other's
        // fields (the non-font partial would write a stale font value, etc).
        let mut cache = self.cache.lock().unwrap();
        let current = match cache.as_ref() {
            Some(s) => s.clone(),
            None => {
                let s = load_from_disk();
                *cache = Some(s.clone());
                s
            }
        };
        let mut base = serde_json::to_value(&current).unwrap();
        if let (Some(base_obj), Some(partial_obj)) = (base.as_object_mut(), partial.as_object()) {
            for (key, value) in partial_obj {
                if value.is_null() {
                    base_obj.remove(key);
                } else {
                    base_obj.insert(key.clone(), value.clone());
                }
            }
        }
        let s: AppSettings = serde_json::from_value(base).unwrap_or(current);

        let path = settings_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(&path, serde_json::to_string_pretty(&s).unwrap()).ok();

        *cache = Some(s.clone());
        s
    }
}

#[cfg(test)]
mod set_cache_tests {
    use super::*;

    #[test]
    fn set_cache_overrides_get() {
        let mgr = SettingsManager::new();
        let mut s = crate::types::AppSettings::default();
        s.editor_font_size = 99;
        mgr.set_cache(s);
        assert_eq!(mgr.get().editor_font_size, 99);
    }

    #[test]
    fn lenient_deserialize_drops_unknown_scalar_keeps_real_settings() {
        // An unknown scalar top-level key (a new renderer-only setting) would
        // otherwise be swept into language_overrides and fail the whole parse.
        let v = serde_json::json!({
            "editorFontSize": 42,
            "someBrandNewRendererSetting": true,
            "[typescript]": { "editorTabSize": 4 }, // a real language override survives
        });
        let s = super::deserialize_lenient(v);
        assert_eq!(s.editor_font_size, 42);
        assert!(s.language_overrides.contains_key("[typescript]"));
    }
}
