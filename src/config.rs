use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CameraConfig {
    #[serde(default)]
    pub selected_camera_index: Option<u32>,
    #[serde(default)]
    pub resolution: ResolutionPreference,
    #[serde(default)]
    pub mirror_horizontal: bool,
    #[serde(default)]
    pub mirror_vertical: bool,
    #[serde(default = "default_target_fps")]
    pub target_fps: u32,
    #[serde(default = "default_auto_start")]
    pub auto_start: bool,
    #[serde(default = "default_port")]
    pub port: u16,
}

impl Default for CameraConfig {
    fn default() -> Self {
        Self {
            selected_camera_index: None,
            resolution: ResolutionPreference::default(),
            mirror_horizontal: false,
            mirror_vertical: false,
            target_fps: default_target_fps(),
            auto_start: default_auto_start(),
            port: default_port(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ResolutionPreference {
    Highest,
    #[default]
    Medium,
    Lowest,
}

fn default_target_fps() -> u32 {
    30
}

fn default_auto_start() -> bool {
    false
}

fn default_port() -> u16 {
    8080
}

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("camera-overlay");
    let _ = fs::create_dir_all(&dir);
    dir.join("config.json")
}

pub fn load() -> CameraConfig {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => CameraConfig::default(),
    }
}

pub fn save(config: &CameraConfig) {
    let path = config_path();
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = fs::write(&path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = CameraConfig::default();
        assert_eq!(config.selected_camera_index, None);
        assert!(matches!(config.resolution, ResolutionPreference::Medium));
        assert!(!config.mirror_horizontal);
        assert!(!config.mirror_vertical);
        assert_eq!(config.target_fps, 30);
        assert!(!config.auto_start);
        assert_eq!(config.port, 8080);
    }

    #[test]
    fn test_config_serialize_deserialize() {
        let config = CameraConfig {
            selected_camera_index: Some(1),
            resolution: ResolutionPreference::Highest,
            mirror_horizontal: true,
            mirror_vertical: false,
            target_fps: 60,
            auto_start: true,
            port: 9090,
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: CameraConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.selected_camera_index, Some(1));
        assert!(matches!(parsed.resolution, ResolutionPreference::Highest));
        assert!(parsed.mirror_horizontal);
        assert!(!parsed.mirror_vertical);
        assert_eq!(parsed.target_fps, 60);
        assert!(parsed.auto_start);
        assert_eq!(parsed.port, 9090);
    }

    #[test]
    fn test_config_deserialize_partial() {
        let json = r#"{"mirror_horizontal": true}"#;
        let config: CameraConfig = serde_json::from_str(json).unwrap();
        assert!(config.mirror_horizontal);
        assert!(!config.mirror_vertical);
        assert_eq!(config.port, 8080);
        assert_eq!(config.target_fps, 30);
    }

    #[test]
    fn test_config_deserialize_empty() {
        let json = "{}";
        let config: CameraConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config, CameraConfig::default());
    }

    #[test]
    fn test_resolution_preference_case() {
        let high: ResolutionPreference = serde_json::from_str(r#""highest""#).unwrap();
        assert!(matches!(high, ResolutionPreference::Highest));

        let med: ResolutionPreference = serde_json::from_str(r#""medium""#).unwrap();
        assert!(matches!(med, ResolutionPreference::Medium));

        let low: ResolutionPreference = serde_json::from_str(r#""lowest""#).unwrap();
        assert!(matches!(low, ResolutionPreference::Lowest));
    }

    #[test]
    fn test_save_and_load() {
        let config = CameraConfig {
            selected_camera_index: Some(2),
            resolution: ResolutionPreference::Lowest,
            mirror_horizontal: true,
            mirror_vertical: true,
            target_fps: 15,
            auto_start: true,
            port: 7777,
        };

        save(&config);
        let loaded = load();

        assert_eq!(loaded.selected_camera_index, config.selected_camera_index);
        assert!(matches!(loaded.resolution, ResolutionPreference::Lowest));
        assert!(loaded.mirror_horizontal);
        assert!(loaded.mirror_vertical);
        assert_eq!(loaded.target_fps, 15);
        assert!(loaded.auto_start);
        assert_eq!(loaded.port, 7777);
    }
}
