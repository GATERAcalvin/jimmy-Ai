// Listen mode: while it is on, the microphone is open and Jimmy keeps a rolling
// written record of the last few minutes of what it hears (a lecture, a call, a
// question read out loud). Nothing is stored on disk; the record is only handed to
// Gemini when you ask something (the screen hotkey). Turn it off and it is gone.
//
// It hears through the microphone, so for a call or video play it through speakers
// the mic can hear, or pick a loopback input such as "Stereo Mix" as the Windows
// default recording device.

import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Recorder } from "./recorder";

/** Each piece is recorded, then transcribed while the next one records. */
const SEGMENT_MS = 12_000;
/** Older than this is forgotten. */
const KEEP_MS = 8 * 60_000;
const KEEP_CHARS = 6000;
/** Quieter than this is silence. */
const MIN_PEAK = 0.02;
const MIN_SECONDS = 1.5;
/** Listening switches itself off after an hour. */
const MAX_RUN_MS = 60 * 60_000;

interface Line {
  at: number;
  text: string;
}

class ListenController {
  private recorder = new Recorder();
  private lines: Line[] = [];
  private run = 0;
  private notify: (message: string) => void = () => {};

  get on(): boolean {
    return State.listening;
  }

  init(notify: (message: string) => void) {
    this.notify = notify;
  }

  /** What was heard recently, oldest first. */
  transcript(now = Date.now()): string {
    this.lines = this.lines.filter((l) => now - l.at < KEEP_MS);
    let text = this.lines.map((l) => l.text).join("\n");
    if (text.length > KEEP_CHARS) text = text.slice(text.length - KEEP_CHARS);
    return text;
  }

  toggle() {
    if (this.on) this.stop("Stopped listening.");
    else void this.start();
  }

  stop(message?: string) {
    this.run++;
    this.recorder.cancel();
    this.lines = [];
    State.listening = false;
    State.notify();
    if (message) this.notify(message);
  }

  private async start() {
    if (!State.settings.voiceEnabled) return;
    const run = ++this.run;
    State.listening = true;
    State.notify();
    Sound.play("question");
    this.notify(`Listening. Press ${State.settings.listenHotkey} to stop, ${State.settings.screenHotkey} to ask.`);
    const until = Date.now() + MAX_RUN_MS;

    while (run === this.run && Date.now() < until) {
      try {
        await this.recorder.start();
      } catch (err) {
        if (run === this.run) this.stop(String((err as Error)?.message ?? err).replace(/^Error:\s*/, ""));
        return;
      }
      await new Promise((r) => window.setTimeout(r, SEGMENT_MS));
      if (run !== this.run) return;
      const rec = await this.recorder.stop();
      if (run !== this.run) return;
      if (rec && rec.seconds >= MIN_SECONDS && rec.peak >= MIN_PEAK) void this.transcribe(rec.wav, run);
    }
    if (run === this.run) this.stop("Stopped listening after an hour.");
  }

  private async transcribe(wav: string, run: number) {
    try {
      const { text } = await Bridge.voiceTranscribe(wav);
      const clean = text.trim();
      if (clean && run === this.run) this.lines.push({ at: Date.now(), text: clean });
    } catch (err) {
      void Bridge.log(`listen: could not transcribe a piece: ${String(err)}`);
    }
  }
}

export const Listen = new ListenController();
