import { create } from "zustand";
import { initialQualityTier, nextAdaptiveTier, type QualityMode, type QualityTier } from "./qualityPolicy";

const device = {
  touch: typeof window !== "undefined" && (window.matchMedia("(any-pointer: coarse)").matches || navigator.maxTouchPoints > 0),
  cores: typeof navigator === "undefined" ? 8 : navigator.hardwareConcurrency || 8,
  memory: typeof navigator === "undefined" ? 8 : (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8,
};
const initialTier = initialQualityTier(device);
let slowSamples = 0, fastSamples = 0, warmup = 0;
function savedMode(): QualityMode {
  try {
    const value = window.localStorage.getItem("skr-graphics-quality");
    if (["auto", "economy", "balanced", "high"].includes(value ?? "")) return value as QualityMode;
  } catch { /* Restricted storage must not prevent rendering. */ }
  return "auto";
}
const mode = savedMode();

interface QualityState {
  mode: QualityMode;
  tier: QualityTier;
  touch: boolean;
  setMode: (mode: QualityMode) => void;
  reportFps: (fps: number) => void;
}

export const useQualityStore = create<QualityState>((set, get) => ({
  mode,
  tier: mode === "auto" ? initialTier : mode,
  touch: device.touch,
  setMode: (mode) => {
    slowSamples = 0; fastSamples = 0; warmup = 0;
    set({ mode, tier: mode === "auto" ? initialTier : mode });
    try { window.localStorage.setItem("skr-graphics-quality", mode); } catch { /* Optional preference. */ }
  },
  reportFps: (fps) => {
    if (get().mode !== "auto" || !Number.isFinite(fps) || fps <= 0 || document.hidden) return;
    // Ignore shader compilation/startup, then use sustained samples to avoid quality flicker.
    if (warmup++ < 5) return;
    slowSamples = fps < 27 ? slowSamples + 1 : 0;
    fastSamples = fps > 53 ? fastSamples + 1 : 0;
    const tier = nextAdaptiveTier(get().tier, slowSamples, fastSamples, initialTier);
    if (tier !== get().tier) {
      slowSamples = 0; fastSamples = 0; warmup = 0;
      set({ tier });
    }
  },
}));
