/**
 * Sound for the cinematic intro: one Web Audio graph, driven by the intro's own clock
 * (introClock), so music and effects follow the picture even when frames drop.
 *
 *   load   — fetch + decode the files in public/audio/intro (once per intro run)
 *   play   — music joins at the clock's position; effects fire on the cue table below
 *   stop   — skip / finish / unmount fade out, cancel pending cues, then close the context
 *   volume — master (on/off) · music · effects, smoothed; settings come from the user's store
 *
 * The browser may refuse to start audio before a click (autoplay policy). Then the status is
 * "blocked", the intro keeps playing silently, and the "เปิดเสียง" button starts the sound in
 * sync from wherever the intro is. A missing or broken file only removes that sound.
 */
import { introClock } from "../components/intro/introTimeline";
import { DEFAULT_INTRO_AUDIO, useIntroAudioSettings } from "./introAudioSettings";
import { sound } from "./soundManager";

export type IntroAudioStatus = "off" | "loading" | "blocked" | "playing" | "partial" | "error" | "unsupported";

export type SoundName = "score" | "bed" | "ignite" | "whoosh" | "scan" | "pulse" | "title" | "outro" | "ui";

const BASE = "/audio/intro/";
const FILES: Record<SoundName, string> = {
  score: "intro-score.mp3",
  bed: "hold-bed.mp3",
  ignite: "sfx-ignite.mp3",
  whoosh: "sfx-whoosh.mp3",
  scan: "sfx-scan.mp3",
  pulse: "sfx-pulse.mp3",
  title: "sfx-title.mp3",
  outro: "sfx-outro.mp3",
  ui: "sfx-ui.mp3",
};

export interface Cue {
  /** Intro time (s) at which the sound starts. */
  at: number;
  sound: Exclude<SoundName, "score" | "bed">;
  gain?: number;
  /** Playback rate (pitch): the three statements rise by 2 and 4 semitones. */
  rate?: number;
  /** What it accompanies (documentation and tests). */
  label: string;
}

/**
 * Times come from the intro itself (cinematicConfig.ts, introLayers.ts, CinematicIntro.tsx).
 * Sparse on purpose: one sound per visual event that matters, never two at the same moment.
 */
export const FULL_CUES: Cue[] = [
  { at: 0.05, sound: "ignite", gain: 0.85, label: "ignition flash and rings (0.05 s)" },
  { at: 1.40, sound: "whoosh", gain: 0.75, label: "camera swoops down to the building (peak 1.95 s)" },
  { at: 2.05, sound: "scan", gain: 0.9, label: "scan plane sweeps up the building (2.05–4.70 s)" },
  { at: 5.20, sound: "pulse", gain: 0.7, rate: 1, label: "statement 01 มองเห็นความเสี่ยง" },
  { at: 6.05, sound: "pulse", gain: 0.7, rate: 1.122, label: "statement 02 วิเคราะห์คอขวด" },
  { at: 6.95, sound: "pulse", gain: 0.75, rate: 1.26, label: "statement 03 ออกแบบทางรอด" },
  { at: 8.86, sound: "title", gain: 0.8, label: "hero flash, school emblem and project title (8.86 s)" },
  { at: 10.95, sound: "outro", gain: 0.75, label: "hand-off to the dashboard (UI reveal 10.5 s, camera settles 11.55 s)" },
];
/** Reduced motion: a still card for 3.6 s — a quiet bed and one soft chime, nothing else. */
export const REDUCED_CUES: Cue[] = [{ at: 0.3, sound: "title", gain: 0.5, label: "title card" }];

/** Overall level in reduced-motion mode (never forced loud). */
const REDUCED_LEVEL = 0.6;
/** Re-align the music when it drifts this far from the picture (slow frames, a stall). */
const RESYNC_DRIFT_S = 0.25;
const RESYNC_MIN_GAP_S = 1.5;
/** A cue whose moment passed by more than this (tab hidden, sound enabled late) is skipped, not played late. */
const LATE_LIMIT_S = 0.3;
const LOOKAHEAD_S = 0.08;

type Listener = () => void;

interface Voice { source: AudioBufferSourceNode; gain: GainNode }

/** perceptual slider → gain */
const curve = (value: number) => value * value;

class IntroAudioEngine {
  status: IntroAudioStatus = "off";
  /** Files that failed to load (shown in the status text). */
  missing: SoundName[] = [];
  private listeners = new Set<Listener>();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private music: (Voice & { startCtx: number; offset: number }) | null = null;
  private bed: Voice | null = null;
  /** Effect voices and the audio-clock time they start at. */
  private pending = new Map<AudioBufferSourceNode, number>();
  private fired = new Set<number>();
  private raf = 0;
  private active = false;
  private mode: "full" | "reduced" = "full";
  private skipping = false;
  private wasHolding = false;
  private lastResync = 0;
  private closeTimer: number | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private generation = 0;
  /** Counters for automated checks (no audio content, just what happened). */
  readonly stats = { cues: [] as string[], musicStarts: 0, musicOffsets: [] as Array<{ offset: number; clock: number }>, resyncs: 0, contexts: 0, closes: 0 };

  /** For automated checks: the audio context's state, or "none" when released. */
  contextState() { return this.ctx?.state ?? "none"; }

  // ---------------------------------------------------------------- state for React
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getStatus = () => this.status;
  private setStatus(status: IntroAudioStatus) {
    if (this.status === status) return;
    this.status = status;
    this.listeners.forEach((listener) => listener());
  }

  // ---------------------------------------------------------------- lifecycle
  /** The intro mounted (or re-mounted: React StrictMode runs effects twice in development). */
  begin(mode: "full" | "reduced") {
    if (this.closeTimer !== null) { window.clearTimeout(this.closeTimer); this.closeTimer = null; }
    this.generation += 1;
    this.mode = mode;
    this.active = true;
    this.skipping = false;
    this.wasHolding = false;
    this.fired.clear();
    this.stopVoices(0.05);
    this.unsubscribeSettings ??= useIntroAudioSettings.subscribe(() => this.applySettings());
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    // A context kept from the previous mount (StrictMode) may have its buses faded to zero.
    if (this.ctx) this.applySettings(true);
    if (useIntroAudioSettings.getState().enabled) this.prepare(false);
    else this.setStatus("off");
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  /** The user pressed Skip: fade quickly (called before the intro unmounts). */
  noteSkip() {
    if (!this.active || this.skipping) return;
    this.skipping = true;
    this.cancelPending();
    this.fadeOutAll(0.45);
  }

  /** The intro unmounted (finished, skipped or the page changed). Fade, then release everything. */
  end() {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.cancelPending();
    // Finished normally: the score's tail and the closing chime carry into the dashboard and fade
    // by themselves. Skipped: already fading (noteSkip). Anything else: a short fade.
    const finished = !this.skipping && introClock.completed && introClock.elapsed >= introClock.duration - 0.05;
    let release = 0.45;
    if (finished) { this.fadeVoice(this.music, 1.6); this.music = null; this.fadeVoice(this.bed, 0.6); this.bed = null; release = 2.1; }
    else if (!this.skipping) { this.fadeOutAll(0.3); release = 0.35; }
    const generation = this.generation;
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (generation === this.generation && !this.active) this.close();
    }, (release + 0.15) * 1000);
  }

  /** User gesture: allow sound (the "เปิดเสียง" button, or switching sound on). */
  async unlock() {
    useIntroAudioSettings.getState().setEnabled(true);
    this.prepare(true);
    const ctx = this.ctx;
    if (!ctx) return;
    try { await ctx.resume(); } catch { /* reported through the state below */ }
    this.refreshStatus();
  }

  /** A short, quiet click for the intro's buttons (only when sound is already playing). */
  uiClick() {
    if (this.ctx?.state === "running" && useIntroAudioSettings.getState().enabled) this.play("ui", this.ctx.currentTime, 0.6, 1, false);
  }

  // ---------------------------------------------------------------- setup
  private prepare(fromGesture: boolean) {
    if (!this.ctx) {
      // The site's shared sound system owns the context (one switch, one autoplay unlock).
      const shared = sound.acquire("intro");
      if (!shared) { this.setStatus("unsupported"); return; }
      this.ctx = shared.ctx;
      this.stats.contexts += 1;
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.sfxBus = ctx.createGain();
      this.musicBus.connect(this.master);
      this.sfxBus.connect(this.master);
      this.master.connect(shared.output);
      this.applySettings(true);
      ctx.addEventListener("statechange", this.onStateChange);
    }
    if (!this.loading) this.loading = this.load();
    this.setStatus("loading");
    void this.loading.then(() => {
      if (!this.ctx) return;
      if (!fromGesture && this.ctx.state === "suspended") {
        // Autoplay: some browsers allow it (site engagement), most need a click first.
        void this.ctx.resume().catch(() => undefined);
        window.setTimeout(() => this.refreshStatus(), 250);
      }
      this.refreshStatus();
    });
  }

  private async load() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.missing = [];
    await Promise.all((Object.keys(FILES) as SoundName[]).map(async (name) => {
      if (this.buffers.has(name)) return;
      try {
        const response = await fetch(BASE + FILES[name], { cache: "force-cache" });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.arrayBuffer();
        // Safari's older decodeAudioData only has the callback form.
        const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
          const result = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
          result?.then(resolve, reject);
        });
        this.buffers.set(name, buffer);
      } catch {
        this.missing.push(name);
      }
    }));
  }

  private refreshStatus() {
    const settings = useIntroAudioSettings.getState();
    if (!settings.enabled) { this.setStatus("off"); return; }
    if (!this.ctx) return;
    if (this.buffers.size === 0 && this.missing.length) { this.setStatus("error"); return; }
    if (this.buffers.size === 0) { this.setStatus("loading"); return; }
    if (this.ctx.state !== "running") {
      // Hidden tab: we suspended it ourselves; that is not the browser blocking us.
      if (document.hidden) return;
      this.setStatus("blocked");
      return;
    }
    this.setStatus(this.missing.length ? "partial" : "playing");
  }

  private applySettings(immediate = false) {
    const { enabled, music, sfx } = useIntroAudioSettings.getState();
    const ctx = this.ctx;
    if (ctx && this.master && this.musicBus && this.sfxBus) {
      const level = this.mode === "reduced" ? REDUCED_LEVEL : 1;
      const at = ctx.currentTime;
      const set = (param: AudioParam, value: number) => {
        param.cancelScheduledValues(at);
        if (immediate) param.setValueAtTime(value, at);
        else param.setTargetAtTime(value, at, 0.06);
      };
      set(this.master.gain, enabled ? level : 0);
      set(this.musicBus.gain, curve(music) * 0.9);
      set(this.sfxBus.gain, curve(sfx));
    }
    if (!enabled) this.setStatus("off");
    else if (this.active && !this.ctx) this.prepare(false);
    else this.refreshStatus();
  }

  // ---------------------------------------------------------------- playback
  private play(name: SoundName, when: number, gain: number, rate: number, music: boolean, offset = 0, loop = false): Voice | null {
    const ctx = this.ctx;
    const buffer = this.buffers.get(name);
    const bus = music ? this.musicBus : this.sfxBus;
    if (!ctx || !buffer || !bus) return null;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    if (loop) {
      // The bed is rendered 9 s long and repeats exactly every 8 s: loop any 8 s window.
      source.loop = true;
      source.loopStart = 0.25;
      source.loopEnd = 8.25;
    }
    const voice = ctx.createGain();
    voice.gain.value = gain;
    source.connect(voice);
    voice.connect(bus);
    source.onended = () => { source.disconnect(); voice.disconnect(); this.pending.delete(source); };
    source.start(when, Math.max(0, offset));
    if (!music) this.pending.set(source, when);
    return { source, gain: voice };
  }

  private fadeVoice(voice: Voice | null, seconds: number) {
    if (!voice || !this.ctx) return;
    const at = this.ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(at);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, at);
      voice.gain.gain.linearRampToValueAtTime(0, at + seconds);
      voice.source.stop(at + seconds + 0.02);
    } catch { /* already stopped */ }
  }

  private startMusic(offset: number, fadeIn: number) {
    const ctx = this.ctx;
    const buffer = this.buffers.get("score");
    if (!ctx || !buffer || offset >= buffer.duration - 0.3) return;
    const voice = this.play("score", ctx.currentTime + 0.01, fadeIn > 0 ? 0 : 1, 1, true, offset);
    if (!voice) return;
    if (fadeIn > 0) voice.gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.01 + fadeIn);
    this.music = { ...voice, startCtx: ctx.currentTime + 0.01, offset };
    this.stats.musicStarts += 1;
    this.stats.musicOffsets.push({ offset: Math.round(offset * 100) / 100, clock: Math.round(introClock.elapsed * 100) / 100 });
  }

  private stopVoices(seconds: number) {
    this.fadeVoice(this.music, seconds);
    this.music = null;
    this.fadeVoice(this.bed, seconds);
    this.bed = null;
  }

  private cancelPending() {
    const at = this.ctx?.currentTime ?? 0;
    // Effects scheduled for the future never play once the intro is over; ones already sounding
    // are left to ring out (finish) or faded by the bus (skip).
    this.pending.forEach((startsAt, source) => {
      if (startsAt > at + 0.01) { try { source.stop(); } catch { /* done */ } this.pending.delete(source); }
    });
  }

  private fadeOutAll(seconds: number) {
    this.stopVoices(seconds);
    if (this.ctx && this.sfxBus) {
      const at = this.ctx.currentTime;
      this.sfxBus.gain.cancelScheduledValues(at);
      this.sfxBus.gain.setValueAtTime(this.sfxBus.gain.value, at);
      this.sfxBus.gain.linearRampToValueAtTime(0, at + Math.min(seconds, 0.3));
    }
  }

  private close() {
    this.stopVoices(0.02);
    const ctx = this.ctx;
    const master = this.master;
    this.ctx = null;
    this.master = this.musicBus = this.sfxBus = null;
    this.buffers.clear();
    this.loading = null;
    this.pending.clear();
    if (ctx) {
      ctx.removeEventListener("statechange", this.onStateChange);
      try { master?.disconnect(); } catch { /* already */ }
      sound.release("intro"); // the shared context stays for the rest of the site
      this.stats.closes += 1;
    }
    this.setStatus(useIntroAudioSettings.getState().enabled ? "loading" : "off");
  }

  private onStateChange = () => this.refreshStatus();

  // ---------------------------------------------------------------- the clock loop
  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const ctx = this.ctx;
    if (!this.active || !ctx || ctx.state !== "running" || this.skipping || !useIntroAudioSettings.getState().enabled) return;
    if (!introClock.ready && introClock.mode === "full") return;
    const t = introClock.elapsed;
    const now = ctx.currentTime;

    // Effects: schedule a little ahead on the audio clock, skip any whose moment has passed.
    const cues = this.mode === "full" ? FULL_CUES : REDUCED_CUES;
    cues.forEach((cue, index) => {
      if (this.fired.has(index) || t < cue.at - LOOKAHEAD_S) return;
      this.fired.add(index);
      if (t - cue.at > LATE_LIMIT_S) return;
      this.play(cue.sound, now + Math.max(0, cue.at - t), cue.gain ?? 1, cue.rate ?? 1, false);
      this.stats.cues.push(`${cue.sound}@${cue.at}`);
    });

    if (this.mode === "reduced") {
      // A quiet bed under the still card, faded out before the hand-off.
      if (!this.bed && t < introClock.duration - 0.8) {
        this.bed = this.play("bed", now, 0, 1, true, 0.25, true);
        this.bed?.gain.gain.linearRampToValueAtTime(0.8, now + 0.6);
      }
      if (this.bed && t >= introClock.duration - 0.9) { this.fadeVoice(this.bed, 0.8); this.bed = null; }
      return;
    }

    // `?intro=preview` holds on the hero frame: the score gives way to a seamless ambient loop.
    if (introClock.holding && !this.wasHolding) {
      this.wasHolding = true;
      this.fadeVoice(this.music, 1.6);
      this.music = null;
      this.bed = this.play("bed", now, 0, 1, true, 0.25, true);
      this.bed?.gain.gain.linearRampToValueAtTime(0.7, now + 1.6);
      return;
    }
    if (!introClock.holding && this.wasHolding) {
      this.wasHolding = false;
      this.fadeVoice(this.bed, 0.6);
      this.bed = null;
      this.startMusic(t, 0.5);
      this.lastResync = now;
      return;
    }
    if (introClock.holding || introClock.completed) return;

    if (!this.music) {
      if (t > 0) { this.startMusic(t, t < 0.15 ? 0 : 0.35); this.lastResync = now; }
      return;
    }
    // Keep the score on the picture: frames slower than real time make the clock lag behind.
    const heard = this.music.offset + (now - this.music.startCtx);
    if (Math.abs(heard - t) > RESYNC_DRIFT_S && now - this.lastResync > RESYNC_MIN_GAP_S) {
      this.fadeVoice(this.music, 0.12);
      this.music = null;
      this.startMusic(t, 0.12);
      this.lastResync = now;
      this.stats.resyncs += 1;
    }
  };

  // ---------------------------------------------------------------- page events
  private onVisibility = () => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (document.hidden) {
      // The intro clock stops with the hidden page; so does the sound (nothing left playing).
      if (ctx.state === "running") void ctx.suspend();
    } else if (useIntroAudioSettings.getState().enabled) {
      void ctx.resume().then(() => {
        // Back in sync with the picture after the pause.
        if (this.music && this.ctx) { this.fadeVoice(this.music, 0.08); this.music = null; }
        this.refreshStatus();
      }).catch(() => this.refreshStatus());
    }
  };

  private onPageHide = () => {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.close();
  };
}

export const introAudio = new IntroAudioEngine();
export { DEFAULT_INTRO_AUDIO };

declare global {
  interface Window { __skrIntroAudio?: IntroAudioEngine }
}
// Automated checks (`?qa=1` or `?introDebug`): what the engine did, never the audio itself.
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  if (params.has("qa") || params.has("introDebug")) window.__skrIntroAudio = introAudio;
}
