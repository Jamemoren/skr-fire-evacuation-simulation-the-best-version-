/**
 * One sound system for the whole site: the intro score and effects, the presentation's ambient
 * bed, short UI effects and spoken narration share one AudioContext, one on/off switch (remembered
 * in this browser, `skr-intro-audio:v1`) and one set of rules:
 *
 *  - autoplay: a page may try to start sound by itself; if the browser refuses, the context stays
 *    suspended and the first real click/tap/key anywhere resumes it (inside that event handler) —
 *    unless the user switched sound off, which is always respected;
 *  - one voice at a time per channel: a new bed or narration replaces the old one (no stacking when
 *    a mode is opened and closed repeatedly);
 *  - narration (browser speech, Thai voice when available) lowers the bed while it speaks;
 *  - a hidden tab pauses everything; leaving a mode calls stopAll(), which fades and cancels.
 * Text on screen always carries the same information: sound is never required to follow along.
 */
import { create } from "zustand";
import { useIntroAudioSettings } from "./introAudioSettings";

export type SoundStatus = "off" | "idle" | "blocked" | "playing" | "unsupported";
type Effect = "ui" | "pulse" | "title" | "whoosh";

const BASE = "/audio/intro/";
const FILES: Record<Effect | "bed", string> = { ui: "sfx-ui.mp3", pulse: "sfx-pulse.mp3", title: "sfx-title.mp3", whoosh: "sfx-whoosh.mp3", bed: "hold-bed.mp3" };
const curve = (value: number) => value * value;

export const useSoundStatus = create<{ status: SoundStatus; speaking: boolean }>(() => ({ status: "idle", speaking: false }));

class SoundManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bedBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private users = new Set<string>();
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private bed: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private bedLevel = 0;
  private speechToken = 0;
  private gestureInstalled = false;
  /** Counters for automated checks. */
  readonly stats = { contexts: 0, resumesFromGesture: 0, beds: 0, speeches: 0, stopAlls: 0 };

  constructor() {
    if (typeof window === "undefined") return;
    useIntroAudioSettings.subscribe(() => this.applySettings());
    document.addEventListener("visibilitychange", () => this.onVisibility());
    window.addEventListener("pagehide", () => this.stopAll(0));
    this.installGestureUnlock();
  }

  // ------------------------------------------------------------ context sharing
  /** The shared context for a user of sound (e.g. "intro"); the returned node is where it plays. */
  acquire(user: string): { ctx: AudioContext; output: AudioNode } | null {
    const ctx = this.ensure();
    if (!ctx || !this.master) return null;
    this.users.add(user);
    return { ctx, output: this.master };
  }
  release(user: string) {
    this.users.delete(user);
    this.refresh();
  }
  /** For checks: the shared context's state. */
  contextState() { return this.ctx?.state ?? "none"; }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) { useSoundStatus.setState({ status: "unsupported" }); return null; }
    try { this.ctx = new Ctor({ latencyHint: "interactive" }); } catch { useSoundStatus.setState({ status: "unsupported" }); return null; }
    this.stats.contexts += 1;
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.bedBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.bedBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(ctx.destination);
    ctx.addEventListener("statechange", () => this.refresh());
    this.applySettings(true);
    // Autoplay attempt: allowed on some browsers / after earlier engagement; otherwise "blocked".
    if (ctx.state === "suspended" && useIntroAudioSettings.getState().enabled && !document.hidden) void ctx.resume().catch(() => undefined).finally(() => this.refresh());
    return ctx;
  }

  private installGestureUnlock() {
    if (this.gestureInstalled) return;
    this.gestureInstalled = true;
    const unlock = (event: Event) => {
      if (!event.isTrusted) return;
      const ctx = this.ctx;
      // Respect "sound off": a click never turns sound on by itself.
      if (!ctx || ctx.state !== "suspended" || document.hidden || !useIntroAudioSettings.getState().enabled) return;
      this.stats.resumesFromGesture += 1;
      void ctx.resume().catch(() => undefined).finally(() => this.refresh());
    };
    for (const type of ["pointerdown", "keydown", "touchend"]) window.addEventListener(type, unlock, { capture: true, passive: true });
  }

  /** "เปิดเสียง" / "ปิดเสียง" (called from a click, so it can start a blocked context). */
  setEnabled(on: boolean) {
    useIntroAudioSettings.getState().setEnabled(on);
    if (on) {
      const ctx = this.ensure();
      if (ctx?.state === "suspended") void ctx.resume().catch(() => undefined).finally(() => this.refresh());
    } else {
      this.stopSpeech();
    }
    this.refresh();
  }

  private applySettings(immediate = false) {
    const { enabled, music, sfx } = useIntroAudioSettings.getState();
    const ctx = this.ctx;
    if (ctx && this.master && this.bedBus && this.sfxBus) {
      const at = ctx.currentTime;
      const set = (param: AudioParam, value: number) => {
        param.cancelScheduledValues(at);
        if (immediate) param.setValueAtTime(value, at); else param.setTargetAtTime(value, at, 0.08);
      };
      set(this.master.gain, enabled ? 1 : 0);
      set(this.bedBus.gain, curve(music) * (useSoundStatus.getState().speaking ? 0.3 : 1));
      set(this.sfxBus.gain, curve(sfx));
    }
    if (!enabled) this.stopSpeech();
    this.refresh();
  }

  private refresh() {
    const enabled = useIntroAudioSettings.getState().enabled;
    let status: SoundStatus;
    if (!enabled) status = "off";
    else if (!this.ctx) status = useSoundStatus.getState().status === "unsupported" ? "unsupported" : "idle";
    else if (this.ctx.state === "running") status = this.users.size || this.bed || useSoundStatus.getState().speaking ? "playing" : "idle";
    else status = document.hidden ? useSoundStatus.getState().status : this.users.size || this.bed ? "blocked" : "idle";
    if (useSoundStatus.getState().status !== status) useSoundStatus.setState({ status });
  }

  private onVisibility() {
    const ctx = this.ctx;
    if (document.hidden) {
      if (ctx?.state === "running") void ctx.suspend();
      if (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking) speechSynthesis.pause();
    } else if (useIntroAudioSettings.getState().enabled) {
      if (ctx && (this.users.size || this.bed)) void ctx.resume().catch(() => undefined).finally(() => this.refresh());
      if (typeof speechSynthesis !== "undefined" && speechSynthesis.paused) speechSynthesis.resume();
    }
    this.refresh();
  }

  // ------------------------------------------------------------ playback
  private load(name: keyof typeof FILES): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    const cached = this.buffers.get(name);
    if (cached) return Promise.resolve(cached);
    let pending = this.loading.get(name);
    if (!pending) {
      pending = fetch(BASE + FILES[name], { cache: "force-cache" })
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
        .then((data) => new Promise<AudioBuffer>((resolve, reject) => {
          const result = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
          result?.then(resolve, reject);
        }))
        .then((buffer) => { this.buffers.set(name, buffer); return buffer; })
        .catch(() => null); // a missing file only removes that sound
      this.loading.set(name, pending);
    }
    return pending;
  }

  /** A short effect (navigation tick, emphasis); silent when sound is off or still blocked. */
  effect(name: Effect, gain = 0.6) {
    if (!useIntroAudioSettings.getState().enabled) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== "running" || !this.sfxBus) return;
    void this.load(name).then((buffer) => {
      if (!buffer || !this.ctx || this.ctx.state !== "running" || !this.sfxBus) return;
      const source = this.ctx.createBufferSource();
      const voice = this.ctx.createGain();
      source.buffer = buffer;
      voice.gain.value = gain;
      source.connect(voice).connect(this.sfxBus);
      source.onended = () => { source.disconnect(); voice.disconnect(); };
      source.start();
    });
  }

  /** A quiet ambient loop for a mode (presentation); a second call replaces, never stacks. */
  startBed(user: string, level = 0.5) {
    this.users.add(user);
    this.bedLevel = level;
    if (!useIntroAudioSettings.getState().enabled) { this.refresh(); return; }
    const ctx = this.ensure();
    if (!ctx) return;
    if (this.bed) { this.fadeBedTo(level); return; }
    void this.load("bed").then((buffer) => {
      if (!buffer || !this.ctx || this.bed || !this.users.has(user) || !this.bedBus) return;
      const source = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      source.buffer = buffer;
      source.loop = true; source.loopStart = 0.25; source.loopEnd = 8.25; // the bed repeats every 8 s
      gain.gain.value = 0;
      source.connect(gain).connect(this.bedBus);
      source.start(this.ctx.currentTime + 0.02, 0.25);
      gain.gain.linearRampToValueAtTime(this.bedLevel, this.ctx.currentTime + 1.2);
      this.bed = { source, gain };
      this.stats.beds += 1;
      this.refresh();
    });
  }
  private fadeBedTo(level: number, seconds = 0.8) {
    if (!this.bed || !this.ctx) return;
    const at = this.ctx.currentTime;
    this.bed.gain.gain.cancelScheduledValues(at);
    this.bed.gain.gain.setValueAtTime(this.bed.gain.gain.value, at);
    this.bed.gain.gain.linearRampToValueAtTime(level, at + seconds);
  }
  stopBed(user: string, seconds = 0.8) {
    this.users.delete(user);
    const bed = this.bed;
    this.bed = null;
    if (bed && this.ctx) {
      const at = this.ctx.currentTime;
      bed.gain.gain.cancelScheduledValues(at);
      bed.gain.gain.setValueAtTime(bed.gain.gain.value, at);
      bed.gain.gain.linearRampToValueAtTime(0, at + seconds);
      try { bed.source.stop(at + seconds + 0.05); } catch { /* stopped */ }
    }
    this.refresh();
  }

  // ------------------------------------------------------------ narration
  narrationAvailable() { return typeof window !== "undefined" && "speechSynthesis" in window; }
  /**
   * Read a caption aloud (when sound and narration are on). The previous narration is cancelled
   * first; the ambient bed is lowered while speaking. Resolves when finished or cancelled.
   */
  speak(text: string): Promise<void> {
    const settings = useIntroAudioSettings.getState();
    if (!settings.enabled || !settings.narration || !this.narrationAvailable() || !text.trim()) return Promise.resolve();
    const token = ++this.speechToken;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "th-TH";
    const voice = speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith("th"));
    if (voice) utterance.voice = voice;
    utterance.rate = 1;
    utterance.volume = Math.max(0.2, curve(settings.sfx) + 0.25);
    this.stats.speeches += 1;
    return new Promise((resolve) => {
      const done = () => {
        if (token === this.speechToken) { useSoundStatus.setState({ speaking: false }); this.applySettings(); }
        resolve();
      };
      utterance.onend = done;
      utterance.onerror = done;
      useSoundStatus.setState({ speaking: true });
      this.applySettings(); // duck the bed
      speechSynthesis.speak(utterance);
    });
  }
  /** Pause/resume narration in place (the story's pause button). */
  pauseSpeech() { if (this.narrationAvailable() && speechSynthesis.speaking) speechSynthesis.pause(); }
  resumeSpeech() { if (this.narrationAvailable() && speechSynthesis.paused) speechSynthesis.resume(); }
  stopSpeech() {
    this.speechToken += 1;
    if (this.narrationAvailable() && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    if (useSoundStatus.getState().speaking) { useSoundStatus.setState({ speaking: false }); this.applySettings(); }
  }

  /** Leaving a mode: fade the bed, cancel narration (effects ring out by themselves). */
  stopAll(seconds = 0.6) {
    this.stats.stopAlls += 1;
    this.stopSpeech();
    const users = [...this.users].filter((user) => user !== "intro");
    users.forEach((user) => this.stopBed(user, seconds));
    this.refresh();
  }
}

export const sound = new SoundManager();

declare global { interface Window { __skrSound?: SoundManager } }
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  if (params.has("qa") || params.has("introDebug")) window.__skrSound = sound;
}
