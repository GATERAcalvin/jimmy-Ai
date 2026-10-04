// The voice controller: hold the hotkey (or click the mic), speak, let go.
//
//   listening → transcribing → thinking (Claude) → speaking
//
// Rust owns the engines (online and offline) and the keys; this file only runs
// the conversation and keeps the island honest about where it is.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type VoicePhase } from "../core/state";
import { askClaude, isChatBusy } from "../views/chat";
import { Recorder } from "./recorder";
import { Speaker } from "./speaker";

/** What the controller needs from the island. */
export interface VoiceHost {
  /** Open the chat and keep it open (no auto-close) while a turn is running. */
  openChat(): void;
  /** Let the island auto-close again. */
  release(): void;
}

/** Shorter than this is a tap, not speech. */
const MIN_SECONDS = 0.4;
/** Quieter than this is a muted or empty microphone. */
const MIN_PEAK = 0.01;

class VoiceController {
  private host: VoiceHost | null = null;
  private recorder = new Recorder();
  /** Bumped by every new turn so a slow answer from an old one is dropped. */
  private turn = 0;
  /** True while the recording is being closed, so a double release is ignored. */
  private stopping = false;

  get phase(): VoicePhase {
    return State.voicePhase;
  }

  async init(host: VoiceHost) {
    this.host = host;
    State.voiceToggle = () => this.toggle();
    this.recorder.onLimit = () => void this.release();
    await onEvent<string>("voice-ptt", (phase) => {
      if (phase === "down") void this.press();
      else if (phase === "up") void this.release();
    });
  }

  /** The mic button: start, stop-and-send, or interrupt, depending on the phase. */
  toggle() {
    if (this.phase === "listening") void this.release();
    else if (this.phase === "speaking") this.interrupt();
    else if (this.phase === "idle") void this.press();
  }

  /** Stops the answer being spoken. */
  interrupt() {
    Speaker.stop();
  }

  // ── Press: start listening ──────────────────────────────────────────────────

  private async press() {
    if (!State.settings.voiceEnabled || !this.host) return;
    if (this.phase === "listening") return; // key auto-repeat
    // Barge-in: talking over the answer cuts it off.
    if (this.phase === "speaking") Speaker.stop();
    else if (this.phase !== "idle" || isChatBusy()) return;
    // An approval card is waiting for a human; don't cover it.
    if (State.pendingApproval) {
      Sound.play("blip");
      return;
    }

    const turn = ++this.turn;
    this.set("listening");
    State.isPinned = true;
    this.host.openChat();
    Sound.play("question");

    try {
      await this.recorder.start();
    } catch (err) {
      if (turn === this.turn) this.fail(errorText(err));
    }
  }

  // ── Release: transcribe, ask, speak ─────────────────────────────────────────

  private async release() {
    // A second release (the hotkey coming up just as the mic button is clicked)
    // must not reach recorder.stop() again: it would report an empty recording
    // and wreck the turn that is already under way.
    if (this.phase !== "listening" || this.stopping) return;
    this.stopping = true;
    const turn = this.turn;

    let rec: Awaited<ReturnType<Recorder["stop"]>>;
    try {
      rec = await this.recorder.stop();
    } finally {
      this.stopping = false;
    }
    if (turn !== this.turn) return;
    if (!rec || rec.seconds < MIN_SECONDS || rec.peak < MIN_PEAK) {
      this.fail("I didn't hear anything. Hold the key while you speak, then let go.");
      return;
    }

    this.set("transcribing");
    State.stateOverride = "thinking";
    State.notify();
    Sound.play("send");

    let text: string;
    try {
      const transcript = await Bridge.voiceTranscribe(rec.wav);
      text = transcript.text.trim();
      void Bridge.log(`voice: heard ${text.length} characters via ${transcript.engine}`);
    } catch (err) {
      if (turn === this.turn) this.fail(errorText(err));
      return;
    }
    if (turn !== this.turn) return;
    if (!text) {
      this.fail("I couldn't make out any words. Try again a little closer to the microphone.");
      return;
    }

    this.set("thinking");
    const reply = await askClaude(text, { spoken: true });
    if (turn !== this.turn) return;
    if (reply == null) {
      // askClaude has already put the error on screen.
      this.finish();
      return;
    }

    if (!State.settings.voiceSpeak) {
      this.finish();
      return;
    }

    // Unpinned while speaking: the island may close, the voice carries on.
    this.host?.release();
    State.isPinned = false;
    this.set("speaking");
    State.stateOverride = "finished";
    State.notify();
    try {
      await Speaker.speak(reply);
    } catch (err) {
      // The answer is still on screen; only the voice failed.
      void Bridge.log(`voice: could not speak the answer: ${errorText(err)}`);
    }
    if (turn === this.turn) this.finish();
  }

  // ── Endings ─────────────────────────────────────────────────────────────────

  private fail(message: string) {
    this.recorder.cancel();
    State.stateOverride = null;
    State.noteMessage = message;
    State.view = "note";
    Sound.play("error");
    this.finish();
  }

  private finish() {
    if (State.stateOverride === "finished" || State.stateOverride === "question") {
      State.stateOverride = null;
    }
    this.set("idle");
    State.isPinned = false;
    this.host?.release();
    State.notify();
  }

  private set(phase: VoicePhase) {
    State.voicePhase = phase;
    State.notify();
    if (phase === "listening") {
      State.stateOverride = "question";
      State.notify();
    }
  }
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
}

export const Voice = new VoiceController();
