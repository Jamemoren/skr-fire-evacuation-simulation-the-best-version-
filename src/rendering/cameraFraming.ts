/** Fit the horizontal subject span on narrow screens without changing the perspective. */
export function fittedViewDistance(distance: number, verticalFov: number, aspect: number, horizontalSpan: number): number {
  const safeAspect = Math.max(0.1, aspect);
  const halfFov = Math.max(1, Math.min(85, verticalFov / 2)) * Math.PI / 180;
  return Math.max(distance, horizontalSpan / (2 * Math.tan(halfFov) * safeAspect) * 1.06);
}
