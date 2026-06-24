/// Where a manifest came from. Only Bundled exists today; Remote/Override slot
/// in here later without touching the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestSource {
    Bundled,
}

impl ManifestSource {
    pub fn label(&self) -> &'static str {
        match self {
            ManifestSource::Bundled => "bundled",
        }
    }
}

/// The bundled TOML for a key (or the generic `default` manifest). The resolution
/// order (bundled → remote → override) lives here; today it is bundled-only.
pub fn resolve(key: &str) -> (&'static str, ManifestSource) {
    let bundled = super::BUNDLED
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, toml)| *toml)
        .unwrap_or(super::DEFAULT_MANIFEST);
    (bundled, ManifestSource::Bundled)
}

pub fn runtime_title_config(key: &str) -> Option<super::TitleConfig> {
    #[derive(serde::Deserialize)]
    struct RuntimeTitleManifest {
        #[serde(default)]
        title: super::TitleConfig,
    }

    let path = crate::paths::internal_data_dir()
        .join("agent-status")
        .join("manifests")
        .join(format!("{key}.toml"));
    let content = std::fs::read_to_string(path).ok()?;
    toml::from_str::<RuntimeTitleManifest>(&content)
        .ok()
        .map(|manifest| manifest.title)
}
