import { create } from "zustand";

/** What the user chose for the intro sound; remembered in this browser for the next visit. */
export interface IntroAudioSettings {
  /** Sound on (the user can switch it off; the browser may still block it until a click). */
  enabled: boolean;
  /** 0–1 slider positions (mapped to gain perceptually by the engine). */
  music: number;
  sfx: number;
}

const KEY = "skr-intro-audio:v1";
export const DEFAULT_INTRO_AUDIO: IntroAudioSettings = { enabled: true, music: 0.7, sfx: 0.7 };

function clamp01(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function load(): IntroAudioSettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_INTRO_AUDIO;
    const data = JSON.parse(raw) as Partial<IntroAudioSettings>;
    return {
      enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_INTRO_AUDIO.enabled,
      music: clamp01(data.music, DEFAULT_INTRO_AUDIO.music),
      sfx: clamp01(data.sfx, DEFAULT_INTRO_AUDIO.sfx),
    };
  } catch {
    return DEFAULT_INTRO_AUDIO; // storage blocked or corrupt: defaults, never a crash
  }
}

function save(settings: IntroAudioSettings) {
  try { window.localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode: not remembered */ }
}

interface Store extends IntroAudioSettings {
  setEnabled: (enabled: boolean) => void;
  setMusic: (value: number) => void;
  setSfx: (value: number) => void;
}

export const useIntroAudioSettings = create<Store>((set, get) => {
  const persist = (patch: Partial<IntroAudioSettings>) => {
    set(patch);
    const { enabled, music, sfx } = get();
    save({ enabled, music, sfx });
  };
  return {
    ...(typeof window === "undefined" ? DEFAULT_INTRO_AUDIO : load()),
    setEnabled: (enabled) => persist({ enabled }),
    setMusic: (value) => persist({ music: clamp01(value, get().music) }),
    setSfx: (value) => persist({ sfx: clamp01(value, get().sfx) }),
  };
});
