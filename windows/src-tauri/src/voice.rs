// Voice — push-to-talk speech in and out, online or offline.
//
//   Speech to text   online   OpenAI transcription
//                    offline  whisper.cpp, a local executable + a ggml model
//   Text to speech   online   OpenAI speech (an mp3 handed to the page to play)
//                    offline  the system voices, spoken by the page itself
//
// The mode setting picks: "online", "offline", or "auto" (online when an OpenAI
// key is saved and the call works, otherwise offline). As everywhere else, keys
// stay on this side of the IPC boundary — the page only ever sees audio and text.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::settings::{self, Settings};
use crate::{island, log, secrets};

pub const OPENAI_KEY: &str = "openai-api-key";

const STT_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
const TTS_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
/// Model names are the part of this most likely to move: check the OpenAI docs
/// if a call starts failing with "model not found".
const STT_MODEL: &str = "whisper-1";
const TTS_MODEL: &str = "tts-1";
/// The speech endpoint refuses more than 4096 characters.
const TTS_MAX_CHARS: usize = 4000;
/// The transcription endpoint refuses uploads over 25 MB.
const MAX_WAV_BYTES: usize = 25 * 1024 * 1024;
/// A local transcription that takes longer than this is hung, not slow.
const WHISPER_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Auto,
    Online,
    Offline,
}

impl Mode {
    fn parse(s: &str) -> Self {
        match s {
            "online" => Mode::Online,
            "offline" => Mode::Offline,
            _ => Mode::Auto,
        }
    }
}

// ── Speech to text ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    /// "openai" or "whisper.cpp" — shown in the settings so you know what ran.
    pub engine: &'static str,
}

pub async fn transcribe(wav_b64: &str, settings: &Settings) -> Result<Transcript, String> {
    let wav = base64_decode(wav_b64).ok_or("The recording could not be read.")?;
    if wav.len() > MAX_WAV_BYTES {
        return Err("That recording is too long. Try a shorter one.".into());
    }
    let mode = Mode::parse(&settings.voice_mode);
    let online_ready = secrets::present(OPENAI_KEY);
    let whisper = find_whisper(settings);

    match mode {
        Mode::Online => online_stt(wav, settings).await,
        Mode::Offline => offline_stt(wav, settings, whisper).await,
        Mode::Auto => {
            if online_ready {
                match online_stt(wav.clone(), settings).await {
                    Ok(t) => return Ok(t),
                    Err(err) => {
                        log::line(format!("voice: online transcription failed ({err}); trying offline"));
                        if whisper.is_none() {
                            return Err(err);
                        }
                    }
                }
            }
            if whisper.is_none() && !online_ready {
                return Err(
                    "No speech engine is ready. Save an OpenAI key, or set up offline voice, in Settings → Voice."
                        .into(),
                );
            }
            offline_stt(wav, settings, whisper).await
        }
    }
}

async fn online_stt(wav: Vec<u8>, settings: &Settings) -> Result<Transcript, String> {
    let key = secrets::get(OPENAI_KEY)
        .ok_or_else(|| "OpenAI key missing. Add it in Settings → Voice.".to_string())?;

    let file = reqwest::multipart::Part::bytes(wav)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", STT_MODEL)
        .text("response_format", "json")
        .part("file", file);
    let lang = settings.voice_language.trim();
    if !lang.is_empty() && lang != "auto" {
        form = form.text("language", lang.to_string());
    }

    let client = http_client(Duration::from_secs(60))?;
    let response = client
        .post(STT_ENDPOINT)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let value = read_json(response, "OpenAI transcription").await?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(Transcript { text, engine: "openai" })
}

async fn offline_stt(
    wav: Vec<u8>,
    settings: &Settings,
    whisper: Option<Whisper>,
) -> Result<Transcript, String> {
    let whisper = whisper.ok_or_else(|| {
        "Offline voice isn't set up yet. Run scripts\\setup-offline-voice.ps1 (see Settings → Voice)."
            .to_string()
    })?;
    let lang = settings.voice_language.clone();
    let text = tauri::async_runtime::spawn_blocking(move || run_whisper(&whisper, &wav, &lang))
        .await
        .map_err(|e| format!("Offline transcription crashed: {e}"))??;
    Ok(Transcript { text, engine: "whisper.cpp" })
}

#[derive(Clone, Debug)]
struct Whisper {
    cli: PathBuf,
    model: PathBuf,
}

/// Where the offline engine lives unless the settings say otherwise.
fn voice_dir() -> PathBuf {
    settings::config_dir().join("voice")
}

fn non_empty(s: &str) -> Option<&str> {
    let s = s.trim();
    (!s.is_empty()).then_some(s)
}

fn find_whisper(settings: &Settings) -> Option<Whisper> {
    let dir = voice_dir();
    let cli = non_empty(&settings.whisper_cli_path)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| find_cli(&dir))?;
    let model = non_empty(&settings.whisper_model_path)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| find_model(&dir))?;
    Some(Whisper { cli, model })
}

/// whisper.cpp's command-line tool: `whisper-cli`, or `main` in older builds.
fn find_cli(dir: &Path) -> Option<PathBuf> {
    const NAMES: &[&str] = &["whisper-cli.exe", "whisper-cli", "main.exe"];
    find_file(dir, 3, &|name| NAMES.contains(&name))
}

/// A ggml model, preferring the sizes that balance speed and accuracy.
fn find_model(dir: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    collect_files(dir, 3, &mut found, &|name| {
        name.starts_with("ggml-") && name.ends_with(".bin") && !name.contains("encoder")
    });
    for size in ["base", "small", "tiny", "medium"] {
        if let Some(p) = found.iter().find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&format!("ggml-{size}")))
                .unwrap_or(false)
        }) {
            return Some(p.clone());
        }
    }
    found.into_iter().next()
}

fn find_file(dir: &Path, depth: u32, wanted: &dyn Fn(&str) -> bool) -> Option<PathBuf> {
    let mut found = Vec::new();
    collect_files(dir, depth, &mut found, wanted);
    found.into_iter().next()
}

fn collect_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>, wanted: &dyn Fn(&str) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
        } else if path.file_name().and_then(|n| n.to_str()).map(wanted).unwrap_or(false) {
            out.push(path);
        }
    }
    if depth > 0 {
        for sub in subdirs {
            collect_files(&sub, depth - 1, out, wanted);
        }
    }
}

fn run_whisper(whisper: &Whisper, wav: &[u8], language: &str) -> Result<String, String> {
    let tmp = voice_dir().join("tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Could not create {}: {e}", tmp.display()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = tmp.join(format!("utterance-{}-{nanos}.wav", std::process::id()));
    std::fs::write(&file, wav).map_err(|e| format!("Could not write the recording: {e}"))?;

    let result = run_whisper_process(whisper, &file, language);
    // The recording is deleted whatever happened.
    let _ = std::fs::remove_file(&file);
    result
}

fn run_whisper_process(whisper: &Whisper, file: &Path, language: &str) -> Result<String, String> {
    let mut cmd = Command::new(&whisper.cli);
    cmd.arg("-m")
        .arg(&whisper.model)
        .arg("-f")
        .arg(file)
        .arg("-nt") // no timestamps
        .arg("-np"); // print nothing but the result

    // English-only models (ggml-*.en.bin) reject any other language.
    let english_only = whisper
        .model
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.contains(".en"))
        .unwrap_or(false);
    if !english_only {
        let lang = non_empty(language).unwrap_or("auto");
        cmd.args(["-l", lang]);
    }
    // The tool's DLLs sit next to it.
    if let Some(parent) = whisper.cli.parent() {
        cmd.current_dir(parent);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", whisper.cli.display()))?;

    // Drain both pipes on their own threads so a chatty process can't block.
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let out_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let deadline = Instant::now() + WHISPER_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Offline transcription timed out.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(format!("Offline transcription failed: {e}")),
        }
    };

    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    if !status.success() {
        let why = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no details");
        return Err(format!("whisper.cpp stopped with {status}: {why}"));
    }
    Ok(clean_transcript(&stdout))
}

/// whisper.cpp prints markers such as [BLANK_AUDIO] for silence and noise;
/// those are not words.
fn clean_transcript(raw: &str) -> String {
    let joined = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let t = joined.trim();
    let marker = (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')'));
    if marker { String::new() } else { t.to_string() }
}

// ── Text to speech ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Speech {
    /// "openai" (audio attached) or "system" (the page speaks it itself).
    pub engine: &'static str,
    /// Base64 audio, only for the online engine.
    pub audio: Option<String>,
    pub mime: &'static str,
    /// The text to speak — cleaned of links, and cut to what the engines accept.
    pub text: String,
}

pub async fn synthesize(text: &str, settings: &Settings) -> Result<Speech, String> {
    let text = clean_for_speech(text);
    if text.is_empty() {
        return Err("Nothing to say.".into());
    }
    let mode = Mode::parse(&settings.voice_mode);
    let system = |text: String| Speech { engine: "system", audio: None, mime: "", text };

    match mode {
        Mode::Offline => Ok(system(text)),
        Mode::Online => online_tts(&text, settings).await,
        Mode::Auto => {
            if !secrets::present(OPENAI_KEY) {
                return Ok(system(text));
            }
            match online_tts(&text, settings).await {
                Ok(speech) => Ok(speech),
                Err(err) => {
                    log::line(format!("voice: online speech failed ({err}); using the system voice"));
                    Ok(system(text))
                }
            }
        }
    }
}

async fn online_tts(text: &str, settings: &Settings) -> Result<Speech, String> {
    let key = secrets::get(OPENAI_KEY)
        .ok_or_else(|| "OpenAI key missing. Add it in Settings → Voice.".to_string())?;
    let voice = non_empty(&settings.tts_voice).unwrap_or("alloy");
    let body = json!({
        "model": TTS_MODEL,
        "voice": voice,
        "input": text,
        "response_format": "mp3",
    });

    let client = http_client(Duration::from_secs(60))?;
    let response = client
        .post(TTS_ENDPOINT)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(api_error("OpenAI speech", status, &text));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    Ok(Speech {
        engine: "openai",
        audio: Some(crate::claude::base64_for(&bytes)),
        mime: "audio/mpeg",
        text: text.to_string(),
    })
}

/// Links read aloud are noise, and the engines have length limits.
fn clean_for_speech(text: &str) -> String {
    let words: Vec<&str> = text
        .split_whitespace()
        .filter(|w| !(w.starts_with("http://") || w.starts_with("https://")))
        .collect();
    let joined = words.join(" ");
    if joined.chars().count() <= TTS_MAX_CHARS {
        return joined;
    }
    let cut: String = joined.chars().take(TTS_MAX_CHARS).collect();
    // End on a sentence if there is one in the last stretch.
    match cut.rfind(['.', '!', '?']) {
        Some(i) if i > TTS_MAX_CHARS / 2 => cut[..=i].to_string(),
        _ => cut,
    }
}

// ── Status ────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct VoiceState {
    hotkey: Mutex<HotkeyStatus>,
}

#[derive(Default, Clone)]
struct HotkeyStatus {
    registered: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub openai_key: bool,
    pub offline_ready: bool,
    pub whisper_cli: Option<String>,
    pub whisper_model: Option<String>,
    pub voice_dir: String,
    pub hotkey_registered: Option<String>,
    pub hotkey_error: Option<String>,
}

pub fn status(app: &AppHandle, settings: &Settings) -> VoiceStatus {
    let whisper = find_whisper(settings);
    let hotkey = app.state::<VoiceState>().hotkey.lock().unwrap().clone();
    VoiceStatus {
        openai_key: secrets::present(OPENAI_KEY),
        offline_ready: whisper.is_some(),
        whisper_cli: whisper.as_ref().map(|w| w.cli.to_string_lossy().to_string()),
        whisper_model: whisper.as_ref().map(|w| w.model.to_string_lossy().to_string()),
        voice_dir: voice_dir().to_string_lossy().to_string(),
        hotkey_registered: hotkey.registered,
        hotkey_error: hotkey.error,
    }
}

// ── Push-to-talk hotkey ───────────────────────────────────────────────────────

/// (Re)registers the global push-to-talk shortcut from the settings. Called at
/// startup and whenever the settings change. The page gets "voice-ptt" events
/// with "down" when the combination is pressed and "up" when it is released.
pub fn apply_hotkey(app: &AppHandle, settings: &Settings) {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();

    let mut state = HotkeyStatus::default();
    if settings.voice_enabled {
        let combo = settings.voice_hotkey.trim().to_string();
        match combo.parse::<Shortcut>() {
            Err(err) => {
                state.error = Some(format!("\"{combo}\" is not a shortcut I understand: {err}"));
            }
            Ok(shortcut) => {
                let handle = app.clone();
                let result = shortcuts.on_shortcut(shortcut, move |_app, _shortcut, event| {
                    let phase = match event.state() {
                        ShortcutState::Pressed => "down",
                        ShortcutState::Released => "up",
                    };
                    let _ = handle.emit_to(island::WINDOW_LABEL, "voice-ptt", phase);
                });
                match result {
                    Ok(()) => state.registered = Some(combo),
                    Err(err) => {
                        state.error = Some(format!("Could not use {combo}: {err}. Another app may own it."));
                    }
                }
            }
        }
    }
    if let Some(err) = &state.error {
        log::line(format!("voice: {err}"));
    }
    *app.state::<VoiceState>().hotkey.lock().unwrap() = state;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

async fn read_json(response: reqwest::Response, what: &str) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(what, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad response from {what}: {e}"))
}

fn api_error(what: &str, status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("{what} {status}: {detail}")
}

/// Standard-alphabet base64 decoder (whitespace ignored, padding optional).
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decode_matches_rfc4648_vectors() {
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(base64_decode("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(base64_decode("Zm9vYmE=").unwrap(), b"fooba");
        assert_eq!(base64_decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(base64_decode("Zm9v\nYmFy").unwrap(), b"foobar");
        assert!(base64_decode("Zm9v!").is_none());
    }

    #[test]
    fn base64_round_trips_binary() {
        let bytes: Vec<u8> = (0..=255).collect();
        let encoded = crate::claude::base64_for(&bytes);
        assert_eq!(base64_decode(&encoded).unwrap(), bytes);
    }

    #[test]
    fn blank_markers_are_not_speech() {
        assert_eq!(clean_transcript(" [BLANK_AUDIO]\n"), "");
        assert_eq!(clean_transcript("(silence)"), "");
        assert_eq!(clean_transcript("  Hello there.\n How are you? "), "Hello there. How are you?");
    }

    #[test]
    fn speech_text_drops_links_and_stays_short() {
        assert_eq!(clean_for_speech("See https://example.com now"), "See now");
        let long = "Sentence one. ".repeat(600);
        let cut = clean_for_speech(&long);
        assert!(cut.chars().count() <= TTS_MAX_CHARS);
        assert!(cut.ends_with('.'));
    }

    // ── Offline engine plumbing, against a stand-in for whisper-cli ───────────────

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jimmy-voice-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn fake_cli(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("whisper-cli");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn whisper_gets_the_documented_flags_and_its_output_is_cleaned() {
        let dir = scratch("flags");
        let args = dir.join("args.txt");
        let cli = fake_cli(
            &dir,
            &format!("echo \"$@\" > '{}'\nprintf '  Hello world.\\n\\n'", args.display()),
        );
        let model = dir.join("ggml-base.bin");
        let wav = dir.join("in.wav");
        std::fs::write(&wav, b"RIFF").unwrap();

        let w = Whisper { cli, model: model.clone() };
        let text = run_whisper_process(&w, &wav, "fr").unwrap();
        assert_eq!(text, "Hello world.");

        let seen = std::fs::read_to_string(&args).unwrap();
        assert!(seen.contains(&format!("-m {}", model.display())), "{seen}");
        assert!(seen.contains(&format!("-f {}", wav.display())), "{seen}");
        assert!(seen.contains("-nt") && seen.contains("-np"), "{seen}");
        assert!(seen.contains("-l fr"), "{seen}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn english_only_models_are_never_given_a_language() {
        let dir = scratch("english");
        let args = dir.join("args.txt");
        let cli = fake_cli(&dir, &format!("echo \"$@\" > '{}'\necho ok", args.display()));
        let w = Whisper { cli, model: dir.join("ggml-base.en.bin") };
        run_whisper_process(&w, &dir.join("x.wav"), "fr").unwrap();
        assert!(!std::fs::read_to_string(&args).unwrap().contains("-l"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_blank_audio_marker_comes_back_empty() {
        let dir = scratch("blank");
        let cli = fake_cli(&dir, "echo ' [BLANK_AUDIO]'");
        let w = Whisper { cli, model: dir.join("ggml-tiny.bin") };
        assert_eq!(run_whisper_process(&w, &dir.join("x.wav"), "auto").unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_engine_reports_its_own_last_line() {
        let dir = scratch("fail");
        let cli = fake_cli(&dir, "echo 'loading model' >&2\necho 'error: failed to load model' >&2\nexit 3");
        let w = Whisper { cli, model: dir.join("ggml-tiny.bin") };
        let err = run_whisper_process(&w, &dir.join("x.wav"), "auto").unwrap_err();
        assert!(err.contains("failed to load model"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_engine_is_a_clear_error_not_a_panic() {
        let w = Whisper {
            cli: PathBuf::from("/nonexistent/whisper-cli"),
            model: PathBuf::from("/nonexistent/ggml-base.bin"),
        };
        let err = run_whisper_process(&w, Path::new("/nonexistent/x.wav"), "auto").unwrap_err();
        assert!(err.contains("Could not start"), "{err}");
    }

    #[test]
    fn the_engine_and_best_model_are_found_where_the_setup_script_puts_them() {
        // setup-offline-voice.ps1 unzips into voice\bin (the zip nests a Release folder)
        // and saves the model straight into voice\.
        let dir = scratch("layout");
        let nested = dir.join("bin").join("Release");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("whisper-cli.exe"), b"").unwrap();
        for m in ["ggml-small.bin", "ggml-tiny.bin", "ggml-base.bin", "ggml-base.en-encoder.bin"] {
            std::fs::write(dir.join(m), b"").unwrap();
        }
        assert_eq!(find_cli(&dir).unwrap(), nested.join("whisper-cli.exe"));
        let model = find_model(&dir).unwrap();
        assert_eq!(model.file_name().unwrap(), "ggml-base.bin"); // base wins; encoder files never do
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_found_in_an_empty_folder() {
        let dir = scratch("empty");
        assert!(find_cli(&dir).is_none());
        assert!(find_model(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_default_hotkey_and_common_alternatives_parse() {
        // A hotkey the plugin can't parse is the one failure the user would see only
        // as "nothing happens", so the shipped default must be proven here.
        let default = crate::settings::Settings::default().voice_hotkey;
        assert!(default.parse::<Shortcut>().is_ok(), "default {default:?} must parse");
        for combo in ["Ctrl+Alt+J", "CommandOrControl+Shift+Space", "Ctrl+Space", "Alt+F9", "F9"] {
            assert!(combo.parse::<Shortcut>().is_ok(), "{combo} should parse");
        }
        assert!("not a shortcut".parse::<Shortcut>().is_err());
    }

    #[test]
    fn mode_defaults_to_auto() {
        assert_eq!(Mode::parse("online"), Mode::Online);
        assert_eq!(Mode::parse("offline"), Mode::Offline);
        assert_eq!(Mode::parse(""), Mode::Auto);
        assert_eq!(Mode::parse("anything"), Mode::Auto);
    }
}
