// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,

    // ── Voice (push-to-talk) ──────────────────────────────────────────────────
    /// Hold the hotkey to talk. Every voice field defaults so an older
    /// settings.json still loads.
    #[serde(default = "yes")]
    pub voice_enabled: bool,
    #[serde(default = "default_voice_hotkey")]
    pub voice_hotkey: String,
    /// "auto" (online when possible, else offline), "online" or "offline".
    #[serde(default = "default_voice_mode")]
    pub voice_mode: String,
    /// Speak the answer aloud after a spoken question.
    #[serde(default = "yes")]
    pub voice_speak: bool,
    /// Language hint for transcription: "auto", or a code like "en" / "fr".
    #[serde(default = "default_voice_language")]
    pub voice_language: String,
    /// Offline engine (whisper.cpp). Empty = look in the voice folder.
    #[serde(default)]
    pub whisper_cli_path: String,
    #[serde(default)]
    pub whisper_model_path: String,
    /// Online speech voice.
    #[serde(default = "default_tts_voice")]
    pub tts_voice: String,
    /// System voice used offline, by name. Empty = the system default.
    #[serde(default)]
    pub offline_voice: String,
}

fn yes() -> bool {
    true
}

fn default_voice_hotkey() -> String {
    "Ctrl+Alt+J".into()
}

fn default_voice_mode() -> String {
    "auto".into()
}

fn default_voice_language() -> String {
    "auto".into()
}

fn default_tts_voice() -> String {
    "alloy".into()
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            voice_enabled: true,
            voice_hotkey: default_voice_hotkey(),
            voice_mode: default_voice_mode(),
            voice_speak: true,
            voice_language: default_voice_language(),
            whisper_cli_path: String::new(),
            whisper_model_path: String::new(),
            tts_voice: default_tts_voice(),
            offline_voice: String::new(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
