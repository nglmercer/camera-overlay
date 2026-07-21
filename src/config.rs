use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
