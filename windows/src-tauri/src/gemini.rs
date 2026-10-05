// Gemini — one place for every call to Google's Generative Language API:
// speech to text, text to speech, and questions about a screenshot.
// The key ("gemini-api-key") lives in the credential store and never leaves Rust.

use std::time::Duration;

use serde_json::{json, Value};

use crate::secrets;

pub const KEY: &str = "gemini-api-key";
const BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
/// Model names are what Google changes most often. These are the first choice; when
/// Google says one is gone, `discover` asks the API which models this key can use.
pub const TEXT_MODEL: &str = "gemini-3.8-flash";
pub const TTS_MODEL: &str = "gemini-2.5-flash-preview-tts";
/// Gemini TTS returns raw 16-bit mono PCM at this rate.
pub const VOICES: &[&str] = &["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
pub const TTS_RATE: u32 = 24_000;

pub fn has_key() -> bool {
    secrets::present(KEY)
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())
}

/// Posts a generateContent request and returns the parsed JSON.
pub async fn generate(model: &str, body: Value, timeout: Duration) -> Result<Value, String> {
    match generate_once(model, &body, timeout).await {
        Err(err) if is_model_gone(&err) => {
            let tts = model.contains("tts");
            match discover(tts, model).await {
                Some(found) => {
                    crate::log::line(format!("gemini: {model} is unavailable; using {found}"));
                    generate_once(&found, &body, timeout).await
                }
                None => Err(err),
            }
        }
        other => other,
    }
}

fn is_model_gone(err: &str) -> bool {
    err.contains(" 404") || err.contains("no longer available") || err.contains("not found")
}

/// Asks which models this key may call and picks a current flash model
/// (a speech model when `tts`), skipping `avoid`. Newest-looking name wins.
async fn discover(tts: bool, avoid: &str) -> Option<String> {
    let key = secrets::get(KEY)?;
    let value: Value = client(Duration::from_secs(20))
        .ok()?
        .get(format!("{BASE}?pageSize=200"))
        .header("x-goog-api-key", key)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let names: Vec<String> = value
        .get("models")?
        .as_array()?
        .iter()
        .filter(|m| {
            m.get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_some_and(|a| a.iter().any(|x| x.as_str() == Some("generateContent")))
        })
        .filter_map(|m| m.get("name").and_then(Value::as_str))
        .map(|n| n.trim_start_matches("models/").to_string())
        .collect();
    pick_model(&names, tts, avoid)
}

pub fn pick_model(names: &[String], tts: bool, avoid: &str) -> Option<String> {
    let mut candidates: Vec<&String> = names
        .iter()
        .filter(|n| n.as_str() != avoid && n.contains("flash") && n.contains("tts") == tts)
        .filter(|n| !n.contains("lite") && !n.contains("image") && !n.contains("live") && !n.contains("thinking"))
        .collect();
    // Prefer stable names over previews, then the highest version number.
    candidates.sort_by(|a, b| {
        let key = |n: &str| (!n.contains("preview") && !n.contains("exp"), version_of(n));
        key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.first().map(|n| n.to_string())
}

/// The first "N.M" in a model name, as a number (gemini-3.8-flash → 3.8).
fn version_of(name: &str) -> f32 {
    name.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|p| p.chars().any(|c| c.is_ascii_digit()))
        .and_then(|p| p.trim_matches('.').parse().ok())
        .unwrap_or(0.0)
}

async fn generate_once(model: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
    let key = secrets::get(KEY)
        .ok_or_else(|| "Gemini key missing. Add it in Settings → Voice.".to_string())?;
    let response = client(timeout)?
        .post(format!("{BASE}/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad response from Gemini: {e}"))
}

pub fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("Gemini {status}: {detail}")
}

/// All text parts of the first candidate, joined.
pub fn first_text(value: &Value) -> String {
    value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("")
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// The first inline audio/image blob of the first candidate, base64.
pub fn first_inline_data(value: &Value) -> Option<String> {
    value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|p| {
            p.get("inlineData").or_else(|| p.get("inline_data"))?.get("data")?.as_str().map(str::to_string)
        })
}

pub fn inline(mime: &str, b64: &str) -> Value {
    json!({ "inline_data": { "mime_type": mime, "data": b64 } })
}

/// Speech to text for a WAV recording.
pub async fn transcribe(wav_b64: &str, language: &str) -> Result<String, String> {
    let hint = if language.is_empty() || language == "auto" {
        String::new()
    } else {
        format!(" The language code is \"{language}\".")
    };
    let prompt = format!(
        "Transcribe this audio exactly as spoken.{hint} Reply with only the transcript, no quotes and no commentary. If there is no speech, reply with nothing."
    );
    let body = json!({ "contents": [{ "parts": [ { "text": prompt }, inline("audio/wav", wav_b64) ] }] });
    let value = generate(TEXT_MODEL, body, Duration::from_secs(60)).await?;
    Ok(first_text(&value))
}

/// Text to speech: returns a complete WAV file.
pub async fn speak(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    let body = json!({
        "contents": [{ "parts": [{ "text": text }] }],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } } }
        }
    });
    let value = generate(TTS_MODEL, body, Duration::from_secs(90)).await?;
    let b64 = first_inline_data(&value).ok_or("Gemini returned no audio.")?;
    let pcm = crate::voice::base64_decode(&b64).ok_or("Gemini returned unreadable audio.")?;
    Ok(wav_from_pcm16(&pcm, TTS_RATE))
}

/// Wraps raw little-endian 16-bit mono PCM in a WAV header.
pub fn wav_from_pcm16(pcm: &[u8], rate: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Ask a question with optional screenshots (PNG/JPEG, base64) and extra context.
pub async fn ask(system: &str, prompt: &str, images: &[(String, String)]) -> Result<String, String> {
    let mut parts = vec![json!({ "text": prompt })];
    for (mime, data) in images {
        parts.push(inline(mime, data));
    }
    let body = json!({
        "system_instruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": parts }],
    });
    let value = generate(TEXT_MODEL, body, Duration::from_secs(90)).await?;
    let text = first_text(&value);
    if text.is_empty() {
        let reason = value.pointer("/promptFeedback/blockReason").and_then(Value::as_str);
        return Err(match reason {
            Some(r) => format!("Gemini would not answer ({r})."),
            None => "Gemini returned no answer.".into(),
        });
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_well_formed() {
        let w = wav_from_pcm16(&[1, 0, 2, 0], 24_000);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()), 36 + 4);
        assert_eq!(&w[36..40], b"data");
        assert_eq!(w.len(), 48);
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 24_000);
    }

    #[test]
    fn picks_a_current_model_when_the_default_is_gone() {
        let names: Vec<String> = [
            "gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-4.0-flash-preview",
            "gemini-3.8-flash-preview-tts", "gemini-2.5-flash-preview-tts", "gemini-3.8-pro",
        ].iter().map(|s| s.to_string()).collect();
        assert_eq!(pick_model(&names, false, "gemini-2.5-flash").as_deref(), Some("gemini-3.8-flash"));
        assert_eq!(pick_model(&names, true, "x").as_deref(), Some("gemini-3.8-flash-preview-tts"));
        assert_eq!(pick_model(&[], false, "x"), None);
        assert!(is_model_gone("Gemini 404 Not Found: This model ... is no longer available to new users"));
    }

    #[test]
    fn reads_text_and_audio_from_a_response() {
        let v = json!({"candidates":[{"content":{"parts":[{"text":"Hello "},{"text":"there"}]}}]});
        assert_eq!(first_text(&v), "Hello there");
        let a = json!({"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"audio/L16","data":"AAAA"}}]}}]});
        assert_eq!(first_inline_data(&a).as_deref(), Some("AAAA"));
    }
}
