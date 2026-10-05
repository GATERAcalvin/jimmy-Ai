// Gemini — one place for every call to Google's Generative Language API:
// speech to text, text to speech, and questions about a screenshot.
// The key ("gemini-api-key") lives in the credential store and never leaves Rust.

use std::time::Duration;

use serde_json::{json, Value};

use crate::secrets;

pub const KEY: &str = "gemini-api-key";
const BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
/// Model names are what Google changes most often: if a call fails with
/// "model not found", update these.
pub const TEXT_MODEL: &str = "gemini-2.5-flash";
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
    let key = secrets::get(KEY)
        .ok_or_else(|| "Gemini key missing. Add it in Settings → Voice.".to_string())?;
    let response = client(timeout)?
        .post(format!("{BASE}/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(&body)
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
    fn reads_text_and_audio_from_a_response() {
        let v = json!({"candidates":[{"content":{"parts":[{"text":"Hello "},{"text":"there"}]}}]});
        assert_eq!(first_text(&v), "Hello there");
        let a = json!({"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"audio/L16","data":"AAAA"}}]}}]});
        assert_eq!(first_inline_data(&a).as_deref(), Some("AAAA"));
    }
}
