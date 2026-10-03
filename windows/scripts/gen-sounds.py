#!/usr/bin/env python3
"""Synthesises Ruth's 28 sound effects into public/sounds/*.wav.

Everything is generated from scratch (soft marimba-like tones, glides and a
little filtered noise), so the sounds are original to Ruth. No dependencies.

    python3 scripts/gen-sounds.py
"""

import math
import os
import random
import struct
import wave

SR = 22050
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "sounds")
random.seed(7)


def silence(dur):
    return [0.0] * int(SR * dur)


def tone(freq, dur, vol=0.7, attack=0.004, decay=None, harm=0.35, wave_kind="sine"):
    """A soft, marimba-ish note: fundamental + decaying 2nd/3rd harmonic."""
    n = int(SR * dur)
    decay = decay if decay is not None else dur * 0.35
    out = []
    for i in range(n):
        t = i / SR
        env = min(1.0, t / attack) * math.exp(-t / max(decay, 1e-4))
        if t > dur - 0.01:
            env *= max(0.0, (dur - t) / 0.01)
        if wave_kind == "tri":
            ph = (t * freq) % 1.0
            s = 4 * abs(ph - 0.5) - 1
        else:
            s = math.sin(2 * math.pi * freq * t)
            s += harm * math.sin(2 * math.pi * freq * 2 * t) * math.exp(-t * 14)
            s += harm * 0.4 * math.sin(2 * math.pi * freq * 3 * t) * math.exp(-t * 22)
        out.append(s * env * vol)
    return out


def glide(f0, f1, dur, vol=0.6, attack=0.005, decay=None, wobble=0.0):
    n = int(SR * dur)
    decay = decay if decay is not None else dur * 0.6
    out = []
    phase = 0.0
    for i in range(n):
        t = i / SR
        k = i / max(1, n - 1)
        f = f0 * (f1 / f0) ** k
        if wobble:
            f *= 1 + wobble * math.sin(2 * math.pi * 7 * t)
        phase += 2 * math.pi * f / SR
        env = min(1.0, t / attack) * math.exp(-t / decay)
        if t > dur - 0.01:
            env *= max(0.0, (dur - t) / 0.01)
        out.append(math.sin(phase) * env * vol)
    return out


def noise(dur, vol=0.4, decay=0.03, lp=0.25):
    n = int(SR * dur)
    out = []
    y = 0.0
    for i in range(n):
        t = i / SR
        y += lp * ((random.random() * 2 - 1) - y)
        out.append(y * math.exp(-t / decay) * vol)
    return out


def mix(*parts):
    n = max(len(p) for p in parts)
    out = [0.0] * n
    for p in parts:
        for i, v in enumerate(p):
            out[i] += v
    return out


def seq(*parts, gap=0.0):
    out = []
    for p in parts:
        out += p
        if gap:
            out += silence(gap)
    return out


def at(offset, part):
    return silence(offset) + part


def normalise(samples, peak=0.85):
    m = max(1e-9, max(abs(s) for s in samples))
    k = peak / m
    return [s * k for s in samples]


def save(name, samples):
    samples = normalise(samples)
    # 6 ms fade-in/out so nothing clicks
    f = int(SR * 0.006)
    for i in range(min(f, len(samples))):
        samples[i] *= i / f
        samples[-1 - i] *= i / f
    path = os.path.join(OUT, name + ".wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples))


# Notes (Hz): a warm major-pentatonic palette around D.
D4, E4, G4, A4, B4 = 293.66, 329.63, 392.0, 440.0, 493.88
D5, E5, G5, A5, B5 = 587.33, 659.25, 783.99, 880.0, 987.77
D6 = 1174.66

SOUNDS = {
    "peek": lambda: seq(tone(G5, 0.09, 0.6), tone(B5, 0.14, 0.6)),
    "open": lambda: seq(tone(D5, 0.07), tone(A5, 0.07), tone(D6, 0.16, 0.55)),
    "close": lambda: seq(tone(D6, 0.06, 0.5), tone(A5, 0.06, 0.5), tone(D5, 0.14, 0.5)),
    "hover": lambda: tone(B5, 0.05, 0.4, decay=0.03),
    "blip": lambda: tone(A5, 0.06, 0.5, decay=0.03),
    "slap": lambda: mix(noise(0.07, 0.8, 0.02, 0.5), glide(260, 90, 0.09, 0.6, decay=0.04)),
    "annoyed": lambda: seq(glide(330, 247, 0.12, 0.55), glide(311, 220, 0.16, 0.55)),
    "dizzy": lambda: glide(420, 640, 0.5, 0.5, decay=0.5, wobble=0.12),
    "greet": lambda: seq(tone(G5, 0.08), tone(A5, 0.08), tone(B5, 0.08), tone(D6, 0.22, 0.6), gap=0.01),
    "work": lambda: seq(tone(E5, 0.05, 0.4), tone(G5, 0.07, 0.4)),
    "finish": lambda: seq(tone(G5, 0.09), tone(B5, 0.09), tone(D6, 0.09), tone(G5 * 2, 0.3, 0.6), gap=0.01),
    "error": lambda: seq(tone(220, 0.12, 0.6, wave_kind="tri"), tone(165, 0.22, 0.6, wave_kind="tri"), gap=0.02),
    "approval": lambda: seq(tone(A5, 0.1, 0.65), tone(A5, 0.1, 0.65), gap=0.07),
    "question": lambda: seq(tone(E5, 0.09), glide(E5, B5, 0.18, 0.55, decay=0.3)),
    "approve": lambda: seq(tone(D5, 0.07), tone(A5, 0.18, 0.65)),
    "gulp": lambda: seq(glide(520, 210, 0.07, 0.6, decay=0.04), glide(300, 160, 0.09, 0.5, decay=0.05)),
    "tick": lambda: mix(noise(0.02, 0.5, 0.006, 0.7), tone(1500, 0.025, 0.3, decay=0.01)),
    "send": lambda: seq(tone(G5, 0.05, 0.5), tone(D6, 0.12, 0.55)),
    "love": lambda: seq(tone(E5, 0.1, 0.55), tone(G5, 0.1, 0.55), tone(B5, 0.26, 0.6), gap=0.01),
    "pop": lambda: mix(glide(300, 900, 0.05, 0.7, decay=0.03), noise(0.03, 0.2, 0.01, 0.6)),
    "proud": lambda: seq(tone(D5, 0.1), tone(G5, 0.1), tone(D6, 0.28, 0.65)),
    "wink": lambda: seq(tone(B5, 0.04, 0.5), tone(D6, 0.09, 0.5), gap=0.015),
    "yawn": lambda: glide(380, 190, 0.55, 0.5, decay=0.5, wobble=0.04),
    "attach": lambda: seq(tone(G5, 0.05, 0.5), tone(A5, 0.05, 0.5), tone(B5, 0.1, 0.55), gap=0.01),
    "think": lambda: seq(tone(D5, 0.12, 0.4), tone(E5, 0.14, 0.4), gap=0.04),
    "search": lambda: seq(glide(500, 800, 0.1, 0.45, decay=0.2), glide(800, 500, 0.1, 0.45, decay=0.2)),
    "rate": lambda: seq(tone(G4, 0.14, 0.5), tone(E4, 0.14, 0.5), tone(D4, 0.26, 0.5), gap=0.02),
    "sleep": lambda: seq(tone(A4, 0.22, 0.4, decay=0.2), tone(E4, 0.34, 0.4, decay=0.3), gap=0.03),
}


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, build in SOUNDS.items():
        save(name, build())
    print(f"{len(SOUNDS)} sounds written to {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
