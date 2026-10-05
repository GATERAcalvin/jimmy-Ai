// Microphone capture. The microphone is only open between start() and stop():
// the tracks and the audio context are released the moment a recording ends, so
// the "in use" indicator goes off and nothing keeps the audio thread awake.

import { encodeWav, peakOf, toBase64, toPcm16k, TARGET_RATE } from "./wav";

export interface Recording {
  /** base64 of a 16 kHz mono 16-bit WAV. */
  wav: string;
  seconds: number;
  /** Loudest sample, 0…1. Near zero means nobody spoke. */
  peak: number;
}

/** A recording this long is a stuck key, not a sentence. */
export const MAX_SECONDS = 60;

export class Recorder {
  /** Called when the time limit ends a recording on its own. */
  onLimit: (() => void) | null = null;

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private limitTimer: number | null = null;
  private starting: Promise<void> | null = null;
  private wanted = false;

  get active(): boolean {
    return this.wanted;
  }

  async start(): Promise<void> {
    if (this.wanted) return;
    this.wanted = true;
    this.chunks = [];
    this.starting = this.open();
    try {
      await this.starting;
    } catch (err) {
      this.release();
      throw new Error(describeMicError(err));
    } finally {
      this.starting = null;
    }
  }

  private async open(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    // Released while the permission prompt was still open.
    if (!this.wanted) return;

    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule("/voice-worklet.js");
    if (!this.wanted) return;

    const node = new AudioWorkletNode(ctx, "jimmy-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (this.wanted) this.chunks.push(e.data);
    };
    const source = ctx.createMediaStreamSource(stream);
    source.connect(node);
    this.node = node;
    this.source = source;
    this.startedAt = performance.now();
    this.limitTimer = window.setTimeout(() => {
      this.limitTimer = null;
      this.onLimit?.();
    }, MAX_SECONDS * 1000);
  }

  /** Ends the recording. Null when it never really started. */
  async stop(): Promise<Recording | null> {
    if (!this.wanted) return null;
    if (this.starting) await this.starting.catch(() => {});
    this.wanted = false;

    const inputRate = this.ctx?.sampleRate ?? TARGET_RATE;
    const seconds = this.node ? (performance.now() - this.startedAt) / 1000 : 0;
    const chunks = this.chunks;
    this.release();
    if (chunks.length === 0) return null;

    const pcm = toPcm16k(chunks, inputRate);
    return {
      wav: toBase64(encodeWav(pcm)),
      seconds,
      peak: peakOf(chunks),
    };
  }

  /** Drops the recording without keeping anything. */
  cancel() {
    this.wanted = false;
    this.release();
  }

  private release() {
    if (this.limitTimer != null) {
      window.clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      /* already gone */
    }
    this.node = null;
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.chunks = [];
    this.wanted = false;
  }
}

function describeMicError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow it in Windows Settings → Privacy & security → Microphone.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone found. Plug one in and try again.";
  }
  if (name === "NotReadableError") {
    return "The microphone is busy in another app.";
  }
  return `Could not open the microphone: ${String((err as Error)?.message ?? err)}`;
}
