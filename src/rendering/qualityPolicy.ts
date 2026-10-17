export type QualityTier = "economy" | "balanced" | "high";
export type QualityMode = "auto" | QualityTier;

export interface DeviceBudget { touch: boolean; cores: number; memory: number; }

export function initialQualityTier(device: DeviceBudget): QualityTier {
  if (device.memory <= 4 || device.cores <= 4) return "economy";
  return device.touch ? "balanced" : "high";
}

export const QUALITY_PRESETS = {
  economy: { dpr: 0.85, shadowSize: 512, shadows: false, particles: 0.35, agentHz: 24 },
  balanced: { dpr: 1.15, shadowSize: 1024, shadows: true, particles: 0.65, agentHz: 36 },
  high: { dpr: 1.65, shadowSize: 2048, shadows: true, particles: 1, agentHz: 55 },
} as const;

export function nextAdaptiveTier(tier: QualityTier, slowSamples: number, fastSamples: number, ceiling: QualityTier): QualityTier {
  const levels: QualityTier[] = ["economy", "balanced", "high"];
  const index = levels.indexOf(tier);
  if (slowSamples >= 4) return levels[Math.max(0, index - 1)];
  if (fastSamples >= 20) return levels[Math.min(levels.indexOf(ceiling), index + 1)];
  return tier;
}
