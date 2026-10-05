// Alarms — saved in the settings folder, checked every second while Jimmy runs.
// When one is due the page gets an "alarm-fired" event and rings (see
// src/assist/alarms.ts). Jimmy has to be running to ring, which is why it can
// start with Windows.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{island, log, settings};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: u64,
    pub label: String,
    /// When it rings, in milliseconds since 1970 (UTC).
    pub at_ms: u64,
    /// "none", "daily" or "weekdays".
    pub repeat: String,
}

#[derive(Default)]
pub struct Alarms {
    list: Mutex<Option<Vec<Alarm>>>,
}

fn file() -> PathBuf {
    settings::config_dir().join("alarms.json")
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn load() -> Vec<Alarm> {
    std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(list: &[Alarm]) {
    if let Some(dir) = file().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(list) {
        if let Err(err) = std::fs::write(file(), text) {
            log::line(format!("alarms: could not save: {err}"));
        }
    }
}

impl Alarms {
    fn with<R>(&self, f: impl FnOnce(&mut Vec<Alarm>) -> R) -> R {
        let mut guard = self.list.lock().unwrap();
        let list = guard.get_or_insert_with(load);
        f(list)
    }

    pub fn all(&self) -> Vec<Alarm> {
        self.with(|l| {
            let mut v = l.clone();
            v.sort_by_key(|a| a.at_ms);
            v
        })
    }

    pub fn add(&self, label: String, at_ms: u64, repeat: String) -> Alarm {
        let repeat = if matches!(repeat.as_str(), "daily" | "weekdays") { repeat } else { "none".into() };
        self.with(|l| {
            let id = l.iter().map(|a| a.id).max().unwrap_or(0) + 1;
            let alarm = Alarm { id, label: label.trim().chars().take(120).collect(), at_ms, repeat };
            l.push(alarm.clone());
            save(l);
            alarm
        })
    }

    /// Removes one alarm, or every alarm when `id` is None. Returns how many went.
    pub fn remove(&self, id: Option<u64>) -> usize {
        self.with(|l| {
            let before = l.len();
            l.retain(|a| id.is_some_and(|i| a.id != i));
            save(l);
            before - l.len()
        })
    }

    /// Alarms due at `now`. One-shot alarms are removed, repeating ones move on.
    pub fn take_due(&self, now: u64) -> Vec<Alarm> {
        self.with(|l| {
            let mut fired = Vec::new();
            l.retain_mut(|a| {
                if a.at_ms > now {
                    return true;
                }
                fired.push(a.clone());
                match next_repeat(a, now) {
                    Some(next) => {
                        a.at_ms = next;
                        true
                    }
                    None => false,
                }
            });
            if !fired.is_empty() {
                save(l);
            }
            fired
        })
    }
}

const DAY_MS: u64 = 86_400_000;

/// The next time a repeating alarm rings after `now`. "weekdays" skips Saturday
/// and Sunday (1970-01-01 was a Thursday, so day 0 is Thursday).
fn next_repeat(a: &Alarm, now: u64) -> Option<u64> {
    if a.repeat == "none" {
        return None;
    }
    let mut at = a.at_ms;
    while at <= now {
        at += DAY_MS;
    }
    if a.repeat == "weekdays" {
        loop {
            let weekday = ((at / DAY_MS) + 4) % 7; // 0 = Sunday … 6 = Saturday
            if weekday != 0 && weekday != 6 {
                break;
            }
            at += DAY_MS;
        }
    }
    Some(at)
}

/// Runs for the life of the app.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            let due = {
                use tauri::Manager;
                app.state::<Alarms>().take_due(now_ms())
            };
            for alarm in due {
                log::line(format!("alarms: ringing \"{}\"", alarm.label));
                let _ = app.emit_to(island::WINDOW_LABEL, "alarm-fired", &alarm);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alarm(at_ms: u64, repeat: &str) -> Alarm {
        Alarm { id: 1, label: "x".into(), at_ms, repeat: repeat.into() }
    }

    #[test]
    fn one_shot_alarms_do_not_repeat() {
        assert_eq!(next_repeat(&alarm(1000, "none"), 5000), None);
    }

    #[test]
    fn daily_alarms_move_to_the_next_day_after_now() {
        let a = alarm(1000, "daily");
        assert_eq!(next_repeat(&a, 1000 + 3 * DAY_MS + 5), Some(1000 + 4 * DAY_MS));
    }

    #[test]
    fn weekday_alarms_skip_the_weekend() {
        // Friday 1970-01-02 08:00 UTC rings, the next ring is Monday 1970-01-05 08:00.
        let fri = DAY_MS + 8 * 3_600_000;
        let mon = 4 * DAY_MS + 8 * 3_600_000;
        assert_eq!(next_repeat(&alarm(fri, "weekdays"), fri), Some(mon));
    }
}
