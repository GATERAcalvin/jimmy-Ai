// Google — Gmail and Calendar, read only.
//
// Sign-in is the standard "installed app" flow with PKCE: a browser window opens,
// you approve, Google sends the browser back to a one-shot listener on 127.0.0.1,
// and only a refresh token is kept (in the credential store). You supply your own
// OAuth client (Settings → Connections), so no shared app can see your mail.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::secrets;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPES: &str =
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly";
const ID_KEY: &str = "google-client-id";
const SECRET_KEY: &str = "google-client-secret";
const REFRESH_KEY: &str = "google-refresh-token";

pub fn connected() -> bool {
    secrets::present(REFRESH_KEY)
}

pub fn configured() -> bool {
    secrets::present(ID_KEY) && secrets::present(SECRET_KEY)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())
}

// ── PKCE ──────────────────────────────────────────────────────────────────────

fn b64url(bytes: &[u8]) -> String {
    crate::claude::base64_for(bytes).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string()
}

pub fn pkce_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// 32 random bytes from the OS-seeded hasher keys, URL-safe encoded.
fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = Vec::with_capacity(32);
    for i in 0..4u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        bytes.extend_from_slice(&h.finish().to_le_bytes());
    }
    b64url(&bytes)
}

fn percent(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn query_param(request_line: &str, name: &str) -> Option<String> {
    let path = request_line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == name).then(|| v.replace('+', " "))
    })
}

// ── Sign in ───────────────────────────────────────────────────────────────────

/// Opens the browser, waits for the approval (up to three minutes) and stores the
/// refresh token. `open` is how to show a URL to the person.
pub async fn connect(open: impl Fn(&str)) -> Result<(), String> {
    let id = secrets::get(ID_KEY).ok_or("Save your Google client ID and secret first.")?;
    let secret = secrets::get(SECRET_KEY).ok_or("Save your Google client ID and secret first.")?;

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_token();
    let state = random_token();

    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
        percent(&id), percent(&redirect), percent(SCOPES), pkce_challenge(&verifier), percent(&state)
    );
    open(&url);

    let code = tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let line = head.lines().next().unwrap_or("").to_string();
            let respond = |body: &'static str| {
                format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", body.len(), body)
            };
            if let Some(err) = query_param(&line, "error") {
                let _ = socket.write_all(respond("<h3>Jimmy was not connected.</h3>You can close this tab.").as_bytes()).await;
                return Err(format!("Google said: {err}"));
            }
            match (query_param(&line, "code"), query_param(&line, "state")) {
                (Some(code), Some(s)) if s == state => {
                    let _ = socket.write_all(respond("<h3>Jimmy is connected.</h3>You can close this tab.").as_bytes()).await;
                    return Ok(code);
                }
                _ => {
                    // The browser also asks for /favicon.ico and the like.
                    let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                }
            }
        }
    })
    .await
    .map_err(|_| "Timed out waiting for you to approve in the browser.".to_string())??;

    let value = token_request(&[
        ("code", code.as_str()),
        ("client_id", id.as_str()),
        ("client_secret", secret.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier.as_str()),
    ])
    .await?;
    let refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .ok_or("Google did not return a refresh token. Remove Jimmy at myaccount.google.com/permissions and try again.")?;
    secrets::set(REFRESH_KEY, refresh)
}

async fn token_request(form: &[(&str, &str)]) -> Result<Value, String> {
    let response = client()?.post(TOKEN_URL).form(form).send().await.map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error_description").or_else(|| v.get("error")).and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("Google sign-in {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

async fn access_token() -> Result<String, String> {
    let refresh = secrets::get(REFRESH_KEY).ok_or("Google isn't connected. Open Settings → Connections.")?;
    let id = secrets::get(ID_KEY).ok_or("Google client ID missing.")?;
    let secret = secrets::get(SECRET_KEY).ok_or("Google client secret missing.")?;
    let value = token_request(&[
        ("refresh_token", refresh.as_str()),
        ("client_id", id.as_str()),
        ("client_secret", secret.as_str()),
        ("grant_type", "refresh_token"),
    ])
    .await?;
    value.get("access_token").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "No access token returned.".into())
}

async fn get_json(url: &str, token: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let response = client()?.get(url).bearer_auth(token).query(query).send().await.map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("Google {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct Mail {
    pub from: String,
    pub subject: String,
    pub date: String,
    pub snippet: String,
}

pub async fn unread_mail(max: usize) -> Result<Vec<Mail>, String> {
    let token = access_token().await?;
    let list = get_json(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        &token,
        &[("q", "is:unread in:inbox".into()), ("maxResults", max.min(15).to_string())],
    )
    .await?;
    let ids: Vec<String> = list
        .get("messages")
        .and_then(Value::as_array)
        .map(|m| m.iter().filter_map(|x| x.get("id").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    for id in ids {
        let msg = get_json(
            &format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}"),
            &token,
            &[("format", "metadata".into()), ("metadataHeaders", "From".into()), ("metadataHeaders", "Subject".into()), ("metadataHeaders", "Date".into())],
        )
        .await?;
        out.push(mail_from(&msg));
    }
    Ok(out)
}

fn mail_from(msg: &Value) -> Mail {
    let header = |name: &str| {
        msg.pointer("/payload/headers")
            .and_then(Value::as_array)
            .and_then(|hs| hs.iter().find(|h| h.get("name").and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case(name))))
            .and_then(|h| h.get("value").and_then(Value::as_str))
            .unwrap_or("")
            .to_string()
    };
    Mail {
        from: header("From"),
        subject: header("Subject"),
        date: header("Date"),
        snippet: msg.get("snippet").and_then(Value::as_str).unwrap_or("").to_string(),
    }
}

// ── Calendar ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct Event {
    pub title: String,
    pub start: String,
    pub end: String,
    pub location: String,
}

pub async fn upcoming_events(now_rfc3339: &str, until_rfc3339: &str) -> Result<Vec<Event>, String> {
    let token = access_token().await?;
    let value = get_json(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        &token,
        &[
            ("timeMin", now_rfc3339.into()),
            ("timeMax", until_rfc3339.into()),
            ("singleEvents", "true".into()),
            ("orderBy", "startTime".into()),
            ("maxResults", "20".into()),
        ],
    )
    .await?;
    Ok(value
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(event_from).collect())
        .unwrap_or_default())
}

fn event_from(e: &Value) -> Event {
    let when = |k: &str| {
        e.pointer(&format!("/{k}/dateTime"))
            .or_else(|| e.pointer(&format!("/{k}/date")))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Event {
        title: e.get("summary").and_then(Value::as_str).unwrap_or("(no title)").to_string(),
        start: when("start"),
        end: when("end"),
        location: e.get("location").and_then(Value::as_str).unwrap_or("").to_string(),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pkce_matches_the_rfc_7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_tokens_are_url_safe_and_different() {
        let (a, b) = (random_token(), random_token());
        assert_ne!(a, b);
        assert!(a.len() >= 43 && a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    }

    #[test]
    fn reads_the_code_from_the_redirect() {
        let line = "GET /?state=abc&code=4%2F0AX&scope=x HTTP/1.1";
        assert_eq!(query_param(line, "code").as_deref(), Some("4%2F0AX"));
        assert_eq!(query_param(line, "error"), None);
        assert_eq!(percent("a b&c"), "a%20b%26c");
    }

    #[test]
    fn parses_a_gmail_message_and_a_calendar_event() {
        let m = json!({"snippet":"Hi","payload":{"headers":[{"name":"from","value":"Ann <a@x.com>"},{"name":"Subject","value":"Lunch?"}]}});
        let mail = mail_from(&m);
        assert_eq!((mail.from.as_str(), mail.subject.as_str(), mail.snippet.as_str()), ("Ann <a@x.com>", "Lunch?", "Hi"));
        let e = json!({"summary":"Standup","start":{"dateTime":"2026-10-06T09:00:00+02:00"},"end":{"date":"2026-10-06"}});
        let ev = event_from(&e);
        assert_eq!(ev.title, "Standup");
        assert_eq!(ev.start, "2026-10-06T09:00:00+02:00");
        assert_eq!(ev.end, "2026-10-06");
    }
}
