/** Invalid numeric input keeps the last usable value instead of poisoning a solver/camera. */
export function finiteBetween(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function integerBetween(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(finiteBetween(value, fallback, min, max));
}
