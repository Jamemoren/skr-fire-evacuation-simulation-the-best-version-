/** Bound stalled frames while allowing a slow device to keep making progress. */
export function activeFrameDelta(delta: number): number {
  return Number.isFinite(delta) && delta > 0 ? Math.min(.1, delta) : 0;
}
