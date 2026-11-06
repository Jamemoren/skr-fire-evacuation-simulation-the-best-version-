"""Render the intro's original score and sound effects (no samples, no third-party audio).

Everything is synthesised here from oscillators and noise, so the project owns the result outright.
The score is written against the intro timeline in src/components/cinematicConfig.ts and
src/components/intro/introLayers.ts (seconds):

  0.05 ignition flash · 1.95 camera swoops to the building · 2.05–4.70 scan plane sweeps the
  building · 5.0 "intelligence" beat (statements 5.2 / 6.05 / 6.95) · 8.86 hero flash + title ·
  10.5 dashboard reveal · 11.55 camera settles · 12.0 hand-off

Usage:  python3 scripts/build-intro-audio.py        (needs numpy, scipy and ffmpeg with libmp3lame)
Output: public/audio/intro/*.mp3
"""
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np
from scipy.signal import fftconvolve, butter, sosfilt

SR = 44100
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "public", "audio", "intro")
rng = np.random.default_rng(20261106)  # fixed seed: the same files every build


# ---------------------------------------------------------------- helpers
def t_axis(seconds):
    return np.arange(int(round(seconds * SR))) / SR


def note(name):
    """'D3' → Hz (A4 = 440)."""
    names = {"C": -9, "C#": -8, "Db": -8, "D": -7, "D#": -6, "Eb": -6, "E": -5, "F": -4, "F#": -3, "Gb": -3, "G": -2, "G#": -1, "Ab": -1, "A": 0, "A#": 1, "Bb": 1, "B": 2}
    pitch, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((names[pitch] + 12 * (octave - 4)) / 12)


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def ramp(t, a, b):
    return smoothstep((t - a) / max(1e-6, b - a))


def env_adsr(n, attack, release, sustain_level=1.0):
    e = np.ones(n) * sustain_level
    a = min(n, int(attack * SR))
    r = min(n - a, int(release * SR))
    if a: e[:a] = np.linspace(0, sustain_level, a) ** 1.5
    if r: e[n - r:] = sustain_level * np.linspace(1, 0, r) ** 2
    return e


def lowpass(x, cutoff, order=2):
    sos = butter(order, min(cutoff, SR * 0.45), "low", fs=SR, output="sos")
    return sosfilt(sos, x)


def highpass(x, cutoff, order=2):
    sos = butter(order, cutoff, "high", fs=SR, output="sos")
    return sosfilt(sos, x)


def bandpass(x, lo, hi, order=2):
    sos = butter(order, [lo, min(hi, SR * 0.45)], "band", fs=SR, output="sos")
    return sosfilt(sos, x)


def swept_lowpass(x, cutoffs, block=256):
    """Time-varying one-pole-ish lowpass: cutoff per block (cheap, click-free enough at 256)."""
    y = np.zeros_like(x)
    state = 0.0
    for start in range(0, len(x), block):
        fc = float(cutoffs[min(start, len(cutoffs) - 1)])
        a = np.exp(-2 * np.pi * fc / SR)
        seg = x[start:start + block]
        out = np.empty_like(seg)
        for i, v in enumerate(seg):
            state = (1 - a) * v + a * state
            out[i] = state
        y[start:start + block] = out
    return y


def saw(freq, t, detune_cents=0.0, phase=0.0):
    """Band-limited (PolyBLEP) sawtooth: no aliasing hiss on the higher pad voices."""
    f = freq * 2 ** (detune_cents / 1200)
    ph = (f * t + phase) % 1.0
    dt = f / SR
    y = 2 * ph - 1
    lo = ph < dt
    x = ph[lo] / dt
    y[lo] -= x + x - x * x - 1
    hi = ph > 1 - dt
    x = (ph[hi] - 1) / dt
    y[hi] -= x * x + x + x + 1
    return y


def reverb(stereo, seconds=2.4, wet=0.28, predelay=0.018):
    n = int(seconds * SR)
    decay = np.exp(-np.linspace(0, 7.0, n))
    out = np.zeros_like(stereo)
    for ch in range(2):
        ir = rng.standard_normal(n) * decay
        ir = lowpass(ir, 5200 - 1600 * ch)
        ir = np.concatenate([np.zeros(int(predelay * SR) + ch * 37), ir])
        ir /= np.sqrt(np.sum(ir ** 2))
        out[:, ch] = fftconvolve(stereo[:, ch], ir)[: len(stereo)]
    return stereo * (1 - wet) + out * wet


def pan(mono, position):
    """position −1 (left) … +1 (right), equal power; position may be an array."""
    angle = (np.asarray(position) + 1) * np.pi / 4
    return np.stack([mono * np.cos(angle), mono * np.sin(angle)], axis=1)


def place(buffer, clip, at):
    start = int(round(at * SR))
    end = min(len(buffer), start + len(clip))
    if end > start:
        buffer[start:end] += clip[: end - start]


def finish(stereo, peak_db=-3.0, rms_db=None):
    x = np.tanh(stereo * 1.15) / np.tanh(1.15)  # gentle soft clip
    if rms_db is not None:
        rms = np.sqrt(np.mean(x ** 2))
        x *= 10 ** (rms_db / 20) / max(rms, 1e-9)
    peak = np.max(np.abs(x))
    limit = 10 ** (peak_db / 20)
    if peak > limit: x *= limit / peak
    return x


def write_mp3(name, stereo, bitrate="128k", mono=False):
    os.makedirs(OUT, exist_ok=True)
    data = stereo.mean(axis=1) if mono else stereo
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        path = tmp.name
    with wave.open(path, "wb") as w:
        w.setnchannels(1 if mono else 2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    target = os.path.join(OUT, f"{name}.mp3")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-codec:a", "libmp3lame", "-b:a", bitrate,
                    "-write_xing", "1", "-id3v2_version", "3", "-metadata", "title=SKR evacuation intro (original synthesis)",
                    "-metadata", "copyright=Original work generated for the SKR evacuation project", target], check=True)
    os.unlink(path)
    print(f"  {name}.mp3  {os.path.getsize(target) / 1024:.1f} KB  {len(data) / SR:.2f} s")


# ---------------------------------------------------------------- the score
SCORE_SECONDS = 13.8
BPM = 120
STEP = 60 / BPM / 4  # sixteenth = 0.125 s

# Harmony (D Dorian): sparse and searching → building → bright lift on the title → calm resolve.
CHORDS = [  # (start, end, voicing)
    (0.0, 2.0, ["D3", "A3", "E4", "F4"]),        # Dm(add9) — the spark, still and open
    (2.0, 3.5, ["D3", "A3", "C4", "F4"]),        # Dm7 — the building appears
    (3.5, 5.0, ["Bb2", "F3", "C4", "D4"]),       # Bbmaj9 — the scan climbs
    (5.0, 6.0, ["G2", "D3", "Bb3", "F4"]),       # Gm7 — "see the risk"
    (6.0, 7.0, ["Bb2", "F3", "A3", "D4"]),       # Bbmaj7 — "analyse the bottleneck"
    (7.0, 8.86, ["C3", "G3", "D4", "E4"]),       # Cadd9 — "design the way out", tension into the title
    (8.86, 10.5, ["F2", "C3", "A3", "E4", "G4"]),  # Fmaj9 — the title lift
    (10.5, SCORE_SECONDS, ["D2", "A2", "E3", "A3", "D4"]),  # Dsus2 — calm hand-off
]
ARP_NOTES = {  # chord tones the arpeggio walks through, per chord index
    1: ["D4", "A4", "C5", "F5", "E5", "A4"],
    2: ["Bb3", "F4", "C5", "D5", "F5", "C5"],
    3: ["G4", "D5", "Bb4", "F5", "D5", "A4"],
    4: ["Bb4", "F5", "A4", "D5", "F5", "C5"],
    5: ["C5", "G5", "D5", "E5", "G5", "D5"],
}


def score():
    t = t_axis(SCORE_SECONDS)
    n = len(t)
    mix = np.zeros((n, 2))

    # 1) Sub drone: present from the first second, swells with the story, never boomy.
    drone_env = 0.10 + 0.25 * ramp(t, 0.0, 2.0) + 0.15 * ramp(t, 5.0, 8.8) - 0.4 * ramp(t, 11.2, SCORE_SECONDS)
    drone = (np.sin(2 * np.pi * note("D1") * t) * 0.6 + np.sin(2 * np.pi * note("D2") * t) * 0.4) * np.clip(drone_env, 0, 1)
    mix += pan(drone * 0.33, 0)

    # 2) Pad: detuned saws through a lowpass that opens with the story.
    pad = np.zeros(n)
    for start, end, voicing in CHORDS:
        a, b = int(start * SR), min(n, int((end + 0.9) * SR))  # overlap = legato release
        seg_t = t[a:b] - start
        seg = np.zeros(b - a)
        for v, name in enumerate(voicing):
            f = note(name)
            seg += saw(f, seg_t, -7, v * 0.13) + saw(f, seg_t, +7, v * 0.29)
        seg /= 2 * len(voicing)
        seg *= env_adsr(b - a, 0.6 if start > 0 else 1.6, 1.0)
        pad[a:b] += seg
    cutoff = 380 + 1500 * ramp(t, 1.0, 5.0) + 1800 * ramp(t, 5.0, 8.7) + 2600 * ramp(t, 8.86, 9.3) - 3200 * ramp(t, 10.6, 12.8)
    pad = swept_lowpass(pad, np.clip(cutoff, 250, 5200))
    pad_gain = 0.35 * ramp(t, 0.0, 1.6) + 0.15 * ramp(t, 8.86, 9.1) - 0.5 * ramp(t, 11.6, SCORE_SECONDS)
    pad *= np.clip(pad_gain, 0, 1)
    lfo = 0.5 + 0.45 * np.sin(2 * np.pi * 0.11 * t)
    mix += np.stack([pad * (0.55 + 0.25 * lfo), pad * (0.8 - 0.25 * lfo)], axis=1)

    # 3) Arpeggio: 16ths from the moment the scan starts, through the statements, stops before the title.
    arp = np.zeros((n, 2))
    pluck_len = int(0.24 * SR)
    pt = np.arange(pluck_len) / SR
    k = 0
    step_time = 2.05
    while step_time < 8.62:
        idx = next(i for i, (s, e, _) in enumerate(CHORDS) if s <= step_time < e)
        notes = ARP_NOTES.get(idx, ARP_NOTES[1])
        f = note(notes[k % len(notes)])
        tone = (np.sin(2 * np.pi * f * pt) * 0.7 + np.sin(2 * np.pi * 2 * f * pt) * 0.18 + saw(f, pt, 4) * 0.12)
        tone *= np.exp(-pt * 16) * (1 - np.exp(-pt * 900))
        level = 0.05 + 0.13 * ramp(step_time, 2.05, 4.6) + 0.06 * ramp(step_time, 5.0, 8.3)
        accent = 1.0 if k % 4 == 0 else 0.72
        side = 0.45 if (k // 2) % 2 else -0.45
        place(arp, pan(tone * level * accent, side), step_time)
        k += 1
        step_time += STEP
    arp[:, 0] = lowpass(arp[:, 0], 4200)
    arp[:, 1] = lowpass(arp[:, 1], 4200)
    # Ping-pong delay (3/16) gives the "data" shimmer.
    delay = int(3 * STEP * SR)
    echo = np.zeros_like(arp)
    echo[delay:, 0] = arp[:-delay, 1] * 0.32
    echo[delay:, 1] = arp[:-delay, 0] * 0.32
    mix += arp + echo

    # 4) Rhythm from the "intelligence" beat: a soft pulse bass, muted kick and light hats.
    for i in range(int((8.5 - 5.0) / (2 * STEP)) + 1):
        at = 5.0 + i * 2 * STEP
        idx = next(j for j, (s, e, _) in enumerate(CHORDS) if s <= at < e)
        root = note(CHORDS[idx][2][0])
        bt = np.arange(int(0.22 * SR)) / SR
        bass = np.sin(2 * np.pi * root * bt) * 0.8 + saw(root, bt) * 0.2
        bass = lowpass(bass * np.exp(-bt * 11) * (1 - np.exp(-bt * 300)), 600)
        place(mix, pan(bass * (0.16 + 0.08 * ramp(at, 5.0, 8.4)), 0), at)
    for i in range(int((8.5 - 5.0) / 0.5) + 1):
        at = 5.0 + i * 0.5
        kt = np.arange(int(0.35 * SR)) / SR
        freq = 45 + 75 * np.exp(-kt * 30)
        kick = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-kt * 9)
        place(mix, pan(kick * (0.16 + 0.10 * ramp(at, 5.0, 8.2)), 0), at)
    for i in range(int((8.5 - 6.0) / 0.5) + 1):
        at = 6.25 + i * 0.5
        ht = np.arange(int(0.06 * SR)) / SR
        hat = highpass(rng.standard_normal(len(ht)), 7000) * np.exp(-ht * 70)
        place(mix, pan(hat * 0.035, 0.3), at)

    # 5) Riser into the title, a breath of silence, then the hit.
    rt = t_axis(8.80 - 7.4)
    noise = rng.standard_normal(len(rt))
    riser = swept_lowpass(noise, 300 + 6500 * (rt / rt[-1]) ** 2) * (rt / rt[-1]) ** 2.2 * 0.16
    riser += np.sin(2 * np.pi * np.cumsum(note("D4") * 2 ** (rt / rt[-1])) / SR) * (rt / rt[-1]) ** 3 * 0.05
    place(mix, pan(riser, np.linspace(-0.4, 0.4, len(rt))), 7.4)
    duck = 1 - 0.85 * (ramp(t, 8.72, 8.80) - ramp(t, 8.86, 8.90))  # tiny gap before the hit
    mix *= duck[:, None]
    ht = t_axis(3.2)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 50 * np.exp(-ht * 12)) / SR) * np.exp(-ht * 2.2) * 0.42
    crack = lowpass(rng.standard_normal(len(ht)), 2500) * np.exp(-ht * 18) * 0.12
    shimmer = sum(np.sin(2 * np.pi * note(nm) * ht) * w for nm, w in (("A5", 0.05), ("E6", 0.04), ("G6", 0.03), ("C7", 0.02)))
    shimmer *= np.exp(-ht * 0.9) * (1 + 0.3 * np.sin(2 * np.pi * 6 * ht)) * (1 - np.exp(-ht * 40))
    place(mix, pan(boom + crack, 0), 8.86)
    place(mix, np.stack([shimmer * 0.9, shimmer * 1.1], axis=1), 8.86)

    # 6) Space, master, tail fade.
    mix = reverb(mix, 2.6, 0.26)
    mix *= (1 - ramp(t, 11.4, SCORE_SECONDS))[:, None]
    mix *= ramp(t, 0.0, 0.05)[:, None]
    return finish(mix, -3.0, rms_db=-21.0)


# ---------------------------------------------------------------- the hold bed (seamless 8 s loop)
def hold_bed():
    """Strictly 8-second-periodic ambience (every partial and LFO repeats every 8 s), rendered 9 s long so
    any 8 s window loops without a seam — even after the MP3 decoder's start offset."""
    period = 8.0
    t = t_axis(9.0)
    bed = np.zeros(len(t))
    for name, w in (("D2", 0.5), ("A2", 0.35), ("E3", 0.25), ("A3", 0.2), ("D4", 0.12), ("F4", 0.06)):
        f = round(note(name) * period) / period  # snap to a multiple of 1/8 Hz
        bed += np.sin(2 * np.pi * f * t) * w * (0.75 + 0.25 * np.sin(2 * np.pi * t / period + w * 7))
    cyc = int(period * SR)
    noise = np.tile(lowpass(rng.standard_normal(cyc), 900), 2)[: len(t)] * 0.05
    bed = bed / 1.5 + noise
    stereo = np.stack([bed * (0.9 + 0.1 * np.sin(2 * np.pi * t / period)), bed * (0.9 - 0.1 * np.sin(2 * np.pi * t / period))], axis=1)
    return finish(stereo, -6.0, rms_db=-24.0)


# ---------------------------------------------------------------- sound effects
def sfx_ignite():
    t = t_axis(1.8)
    thump = np.sin(2 * np.pi * np.cumsum(55 + 40 * np.exp(-t * 25)) / SR) * np.exp(-t * 8) * 0.5
    bloom = sum(np.sin(2 * np.pi * note(nm) * t) * w for nm, w in (("D5", 0.3), ("A5", 0.22), ("E6", 0.12)))
    bloom *= (1 - np.exp(-t * 30)) * np.exp(-t * 2.2)
    air = bandpass(rng.standard_normal(len(t)), 1500, 9000) * np.exp(-t * 6) * 0.08
    mono = thump + bloom + air
    return finish(reverb(pan(mono, 0), 1.8, 0.3), -4.0)


def sfx_whoosh():
    t = t_axis(1.1)
    shape = np.exp(-((t - 0.55) / 0.22) ** 2)
    noise = rng.standard_normal(len(t))
    sweep = 400 + 3200 * np.exp(-((t - 0.55) / 0.3) ** 2)
    body = swept_lowpass(noise, sweep) * shape
    body = highpass(body, 150)
    return finish(pan(body * 0.9, np.linspace(-0.7, 0.7, len(t))), -5.0)


def sfx_scan():
    t = t_axis(2.7)
    rise = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (1.6 * t / t[-1])) / SR) * 0.10
    rise *= ramp(t, 0, 0.25) * (1 - ramp(t, 2.2, 2.65))
    hiss = swept_lowpass(rng.standard_normal(len(t)), 800 + 4000 * t / t[-1]) * 0.05 * ramp(t, 0, 0.4) * (1 - ramp(t, 2.1, 2.6))
    ticks = np.zeros(len(t))
    at = 0.12
    while at < 2.45:  # data ticks, slightly irregular like a read-out
        bt = np.arange(int(0.012 * SR)) / SR
        blip = np.sin(2 * np.pi * (2400 + 600 * rng.random()) * bt) * np.exp(-bt * 400)
        place(ticks, blip * (0.05 + 0.04 * at / 2.45), at)
        at += 0.055 + 0.03 * rng.random()
    lock_t = np.arange(int(0.25 * SR)) / SR
    lock = (np.sin(2 * np.pi * note("A5") * lock_t) + 0.5 * np.sin(2 * np.pi * note("E6") * lock_t)) * np.exp(-lock_t * 14) * 0.12
    mono = rise + hiss + ticks
    place(mono, lock, 2.45)
    return finish(reverb(pan(mono, np.sin(2 * np.pi * 0.4 * t) * 0.3), 1.2, 0.2), -6.0)


def sfx_pulse():
    t = t_axis(0.7)
    ping = np.sin(2 * np.pi * np.cumsum(note("A5") * (1 + 0.04 * np.exp(-t * 30))) / SR) * np.exp(-t * 7) * (1 - np.exp(-t * 400)) * 0.35
    sub = np.sin(2 * np.pi * note("A2") * t) * np.exp(-t * 10) * 0.35
    return finish(reverb(pan(ping + sub, 0), 1.0, 0.25), -5.0)


def sfx_title():
    t = t_axis(2.4)
    bell = np.zeros(len(t))
    for nm, w in (("D6", 0.25), ("A6", 0.18), ("F#6", 0.1), ("E7", 0.07)):
        f = note(nm)
        for ratio, pw in ((1, 1), (2.76, 0.35), (5.4, 0.12)):  # inharmonic bell partials
            bell += np.sin(2 * np.pi * f * ratio * t) * w * pw * np.exp(-t * (1.6 + ratio))
    bell *= 1 - np.exp(-t * 200)
    sparkle = highpass(rng.standard_normal(len(t)), 6000) * np.exp(-t * 5) * 0.03
    return finish(reverb(np.stack([bell * 0.95 + sparkle, bell * 1.05 + sparkle], axis=1), 2.2, 0.35), -6.0)


def sfx_outro():
    t = t_axis(2.0)
    a = np.sin(2 * np.pi * note("A5") * t) * np.exp(-t * 3.5) * (1 - np.exp(-t * 300))
    tb = np.clip(t - 0.18, 0, None)
    b = np.sin(2 * np.pi * note("D5") * tb) * np.exp(-tb * 2.6) * (t > 0.18) * (1 - np.exp(-tb * 300))
    air = swept_lowpass(rng.standard_normal(len(t)), 600 + 1500 * np.exp(-t * 2)) * np.exp(-((t - 0.4) / 0.35) ** 2) * 0.12
    mono = (a * 0.22 + b * 0.26) + air
    return finish(reverb(pan(mono, np.linspace(0.3, -0.2, len(t))), 2.0, 0.35), -7.0)


def sfx_ui():
    t = t_axis(0.12)
    click = np.sin(2 * np.pi * 1320 * t) * np.exp(-t * 60) * 0.4 + bandpass(rng.standard_normal(len(t)), 2000, 8000) * np.exp(-t * 300) * 0.15
    return finish(pan(click, 0), -9.0)


if __name__ == "__main__":
    print("Rendering intro audio (original synthesis) →", os.path.relpath(OUT, ROOT))
    write_mp3("intro-score", score(), "128k")
    write_mp3("hold-bed", hold_bed(), "64k", mono=True)
    for name, render in (("sfx-ignite", sfx_ignite), ("sfx-whoosh", sfx_whoosh), ("sfx-scan", sfx_scan), ("sfx-pulse", sfx_pulse),
                         ("sfx-title", sfx_title), ("sfx-outro", sfx_outro), ("sfx-ui", sfx_ui)):
        write_mp3(name, render(), "96k", mono=True)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT) if f.endswith(".mp3"))
    print(f"total {total / 1024:.1f} KB")
    sys.exit(0)
