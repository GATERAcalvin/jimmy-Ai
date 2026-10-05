// Speaking. Rust decides how: online it returns audio to play, offline it hands
// back the cleaned text and we speak it with one of the system voices. Either
// way nothing is left running afterwards — the audio context is closed when the
// utterance ends.

import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { fromBase64 } from "./wav";

class SpeakerEngine {
  private token = 0;
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private resolveCurrent: (() => void) | null = null;

  get speaking(): boolean {
    return this.resolveCurrent != null;
  }

  /** Resolves when the speech ends — or is stopped. Rejects only when nothing could speak. */
  async speak(text: string, opts: { offlineVoice?: string } = {}): Promise<{ engine: string }> {
    this.stop();
    const token = ++this.token;

    const speech = await Bridge.voiceSynthesize(text);
    if (token !== this.token) return { engine: speech.engine }; // stopped while we waited

    if (speech.engine === "gemini" && speech.audio) {
      await this.playAudio(speech.audio, token);
    } else {
      await this.speakWithSystemVoice(speech.text, token, opts.offlineVoice);
    }
    return { engine: speech.engine };
  }

  stop() {
    this.token++;
    try {
      this.source?.stop();
    } catch {
      /* not started */
    }
    this.source = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.finish();
  }

  private finish() {
    const resolve = this.resolveCurrent;
    this.resolveCurrent = null;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    resolve?.();
  }

  private async playAudio(b64: string, token: number) {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const buffer = await ctx.decodeAudioData(fromBase64(b64));
    if (token !== this.token) {
      void ctx.close().catch(() => {});
      return;
    }
    await new Promise<void>((resolve) => {
      this.resolveCurrent = resolve;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (this.source === source) this.source = null;
        if (token === this.token) this.finish();
      };
      this.source = source;
      void ctx.resume().then(() => source.start());
    });
  }

  private async speakWithSystemVoice(text: string, token: number, offlineVoice?: string) {
    if (!("speechSynthesis" in window)) {
      throw new Error("This computer has no system voice to speak with.");
    }
    const voice = await findVoice(offlineVoice ?? State.settings.offlineVoice);
    if (token !== this.token) return;

    // Long text in one utterance can stall some engines: speak it sentence by sentence.
    const parts = splitSentences(text);
    await new Promise<void>((resolve) => {
      this.resolveCurrent = resolve;
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        }
        const last = i === parts.length - 1;
        u.onend = () => {
          if (last && token === this.token) this.finish();
        };
        u.onerror = () => {
          if (token === this.token) this.finish();
        };
        window.speechSynthesis.speak(u);
      });
    });
  }
}

/** Sentence-sized pieces, each short enough for any engine. */
export function splitSentences(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > max && current) {
      out.push(current.trim());
      current = "";
    }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out.length ? out : [text];
}

/** Voices load lazily in Chromium: the first call to getVoices() is often empty. */
export function listSystemVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve([]);
    const now = window.speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    const done = () => resolve(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    window.setTimeout(done, 1200);
  });
}

async function findVoice(name: string): Promise<SpeechSynthesisVoice | null> {
  if (!name) return null;
  const voices = await listSystemVoices();
  return voices.find((v) => v.name === name) ?? null;
}

export const Speaker = new SpeakerEngine();
