// Rings when Rust says an alarm is due: sound, the label on the island, and the
// label spoken. Any click or key — or saying "stop" — silences it; it gives up on
// its own after 45 seconds.

import { onEvent, type Alarm } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Speaker } from "../voice/speaker";

const RING_MS = 2500;
const GIVE_UP_MS = 45_000;

let timer: number | null = null;
let stopAt = 0;
let onStop: (() => void) | null = null;

export function isRinging(): boolean {
  return timer != null;
}

/** Returns true if something was ringing. */
export function stopRinging(): boolean {
  if (timer == null) return false;
  window.clearInterval(timer);
  timer = null;
  Speaker.stop();
  State.isPinned = false;
  State.stateOverride = null;
  State.notify();
  onStop?.();
  return true;
}

export async function initAlarms(host: { show: () => void; release: () => void }) {
  onStop = host.release;
  const silence = () => void stopRinging();
  window.addEventListener("pointerdown", silence, true);
  window.addEventListener("keydown", silence, true);

  await onEvent<Alarm>("alarm-fired", (alarm) => {
    stopRinging();
    State.noteMessage = `⏰ ${alarm.label}`;
    State.view = "note";
    State.isPinned = true;
    State.stateOverride = "question";
    State.notify();
    host.show();
    stopAt = Date.now() + GIVE_UP_MS;
    const ring = () => {
      if (Date.now() > stopAt) return void stopRinging();
      Sound.play("approval");
    };
    ring();
    timer = window.setInterval(ring, RING_MS);
    if (State.settings.voiceSpeak) {
      void Speaker.speak(alarm.label === "Alarm" ? "Your alarm is going off." : alarm.label).catch(() => {});
    }
  });
}
