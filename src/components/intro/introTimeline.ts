import {
  CINEMATIC_BEATS,
  CINEMATIC_INTRO_DURATION_SECONDS,
  CINEMATIC_REDUCED_DURATION_SECONDS,
  CINEMATIC_UI_REVEAL_SECONDS,
  type CinematicBeat,
} from "../cinematicConfig";

export type IntroMode = "full" | "reduced";
type UiState = "playing" | "revealing";

interface DomCue {
  el: HTMLElement;
  start: number;
  end: number;
  on: boolean;
}

/** 0 = minimal, 1 = balanced, 2 = full. Lowered (never raised) while the intro plays. */
export type IntroEffectLevel = 0 | 1 | 2;

/**
 * One authoritative clock for the whole opening. The WebGL director advances it with
 * frame delta time; the DOM overlay only advances it itself when WebGL is not ticking
 * (context lost, very slow first compile), so captions and camera can never drift apart.
 */
class IntroClock {
  mode: IntroMode = "full";
  duration = CINEMATIC_INTRO_DURATION_SECONDS;
  /** Story position in seconds (holds during `?intro=preview`). */
  elapsed = 0;
  /** Free-running seconds since the opening started; loops keep moving during a hold. */
  motion = 0;
  /** GL has rendered the warm-up frames (shader variants compiled). */
  ready = false;
  holdAt: number | null = null;
  holding = false;
  debugPaused = false;
  completed = false;
  lastGlTick = 0;
  mountedAt = 0;
  effectLevel: IntroEffectLevel = 2;
  root: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private cues: DomCue[] = [];
  private beat: CinematicBeat | "" = "";
  private uiState: UiState | "" = "";
  private readyShown = false;
  onComplete: (() => void) | null = null;
  onHoldChange: ((holding: boolean) => void) | null = null;

  reset(mode: IntroMode, holdAt: number | null) {
    this.mode = mode;
    this.duration = mode === "reduced" ? CINEMATIC_REDUCED_DURATION_SECONDS : CINEMATIC_INTRO_DURATION_SECONDS;
    this.elapsed = 0;
    this.motion = 0;
    this.ready = mode === "reduced";
    this.holdAt = mode === "full" ? holdAt : null;
    this.holding = false;
    this.debugPaused = false;
    this.completed = false;
    this.lastGlTick = 0;
    this.mountedAt = performance.now();
    this.beat = "";
    this.uiState = "";
    this.readyShown = false;
  }

  attach(root: HTMLElement | null) {
    this.root = root;
    this.progressEl = root?.querySelector<HTMLElement>("[data-intro-progress]") ?? null;
    this.cues = root
      ? Array.from(root.querySelectorAll<HTMLElement>("[data-cue]")).map((el) => {
        const [start, end] = (el.dataset.cue ?? "0 0").split(" ").map(Number);
        return { el, start, end, on: false };
      })
      : [];
    this.beat = "";
    this.uiState = "";
    this.readyShown = false;
    this.sync();
  }

  get progress() {
    return Math.min(1, this.elapsed / this.duration);
  }

  advance(dt: number) {
    if (this.completed || !Number.isFinite(dt) || dt <= 0) return;
    this.motion += dt;
    if (!this.debugPaused) {
      if (this.holdAt !== null && !this.holding && this.elapsed < this.holdAt && this.elapsed + dt >= this.holdAt) {
        this.elapsed = this.holdAt;
        this.holding = true;
        this.onHoldChange?.(true);
      }
      if (!this.holding) this.elapsed = Math.min(this.duration, this.elapsed + dt);
    }
    this.sync();
    if (this.elapsed >= this.duration && !this.debugPaused) {
      this.completed = true;
      this.onComplete?.();
    }
  }

  /** Continue from the preview hold into the hand-off. */
  release() {
    if (!this.holding) return false;
    this.holding = false;
    this.holdAt = null;
    this.onHoldChange?.(false);
    return true;
  }

  seek(seconds: number) {
    this.elapsed = Math.max(0, Math.min(this.duration - 0.001, seconds));
    this.debugPaused = true;
    this.sync();
  }

  /** Stop for good (finished, skipped or unmounted); later ticks become no-ops. */
  stop() {
    this.completed = true;
    this.root = null;
    this.progressEl = null;
    this.cues = [];
  }

  sync() {
    // Detached (skipped/unmounted): never touch the document again.
    if (!this.root) return;
    const t = this.elapsed;
    if (this.progressEl) this.progressEl.style.transform = `scaleX(${this.progress.toFixed(4)})`;
    for (const cue of this.cues) {
      const on = t >= cue.start && t < cue.end;
      if (on !== cue.on) {
        cue.on = on;
        if (on) cue.el.setAttribute("data-on", "");
        else cue.el.removeAttribute("data-on");
      }
    }
    if (this.ready !== this.readyShown) {
      this.readyShown = this.ready;
      this.root.dataset.ready = this.ready ? "1" : "0";
    }
    const beat = this.mode === "reduced" ? "hero" : beatAt(t);
    if (beat !== this.beat) {
      this.beat = beat;
      this.root.dataset.beat = beat;
    }
    const revealAt = this.mode === "reduced" ? this.duration - 0.9 : CINEMATIC_UI_REVEAL_SECONDS;
    const uiState: UiState = t >= revealAt ? "revealing" : "playing";
    if (uiState !== this.uiState && typeof document !== "undefined") {
      this.uiState = uiState;
      document.documentElement.dataset.skrIntro = uiState;
    }
  }
}

export function beatAt(t: number): CinematicBeat {
  if (t < CINEMATIC_BEATS.spark[1]) return "spark";
  if (t < CINEMATIC_BEATS.reveal[1]) return "reveal";
  if (t < CINEMATIC_BEATS.intelligence[1]) return "intelligence";
  if (t < CINEMATIC_BEATS.hero[1]) return "hero";
  return "handoff";
}

export const introClock = new IntroClock();

// ---------------------------------------------------------------------------
// Small easing toolkit shared by the camera, shaders and envelopes.
// ---------------------------------------------------------------------------
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
export const smoother = (v: number) => {
  const x = clamp01(v);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
export const easeOutCubic = (v: number) => 1 - (1 - clamp01(v)) ** 3;
export const easeInOutCubic = (v: number) => {
  const x = clamp01(v);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
/** 0 → 1 between a and b. */
export const ramp = (t: number, a: number, b: number) => smooth((t - a) / Math.max(1e-4, b - a));
/** Fade in over [a, b], hold, fade out over [c, d]. */
export const envelope = (t: number, a: number, b: number, c: number, d: number) => Math.min(ramp(t, a, b), 1 - ramp(t, c, d));

/** Reduced-motion users get a still establishing frame with fades only. */
export function resolveIntroMode(): IntroMode {
  if (typeof window === "undefined") return "full";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full";
}
