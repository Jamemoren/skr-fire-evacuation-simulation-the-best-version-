import type { SimEdge, Vec3 } from "./types";
import { pointInsideWalkableCorridor, walkableHalfWidth } from "./walkable";

export function edgeAllowsDetour(edge: SimEdge): boolean {
  // Door openings and switchback stairs retain their exact, narrow physical portals.
  return edge.kind === "outdoor" || edge.kind === "assembly"
    || ((edge.kind === "corridor" || edge.kind === "junction") && !edge.id.includes("door"));
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function segmentInsideWalkway(a: Vec3, b: Vec3, path: Vec3[], edge: SimEdge): boolean {
  const count = Math.max(1, Math.ceil(distance(a, b) / 0.16));
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const point: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    if (!pointInsideWalkableCorridor(point, path, edge)) return false;
  }
  return true;
}

interface DetourOptions {
  start?: Vec3;
  allowStartLanes?: boolean;
  allowGoalLanes?: boolean;
  goalAllowed?: (point: Vec3) => boolean;
  riskAt: (point: Vec3) => { fire: number; heat: number; smoke: number; blocked: boolean };
  segmentBlocked: (from: Vec3, to: Vec3) => boolean;
}

/** A* across the full walkable width. Links can move laterally and backwards, so several
 * staggered fires can require alternating sides instead of one fixed offset around all fires.
 * Every link, including smoothing and the actual-position join, is checked along its length.
 */
export function planFireDetour(path: Vec3[], edge: SimEdge, options: DetourOptions): Vec3[] | null {
  if (!edgeAllowsDetour(edge) || path.length < 2) return null;
  const start = options.start ?? path[0];
  const goal = path[path.length - 1];
  const safeSegment = (a: Vec3, b: Vec3) => !options.segmentBlocked(a, b)
    && segmentInsideWalkway(a, b, path, edge);
  const startBlocked = options.riskAt(start).blocked, goalBlocked = options.riskAt(goal).blocked;
  if ((startBlocked && !options.allowStartLanes) || (goalBlocked && !options.allowGoalLanes)) return null;
  if (!startBlocked && !goalBlocked && (options.goalAllowed?.(goal) ?? true) && safeSegment(start, goal)) return [[...start], [...goal]];

  const centers: Vec3[] = [path[0]];
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1], b = path[i];
    const steps = Math.max(1, Math.ceil(distance(a, b) / 0.5));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      centers.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  const halfWidth = Math.max(0, walkableHalfWidth(edge) - 0.04);
  const halfLanes = Math.max(1, Math.ceil(halfWidth / 0.28));
  const lanes = halfLanes * 2 + 1;
  const points: Vec3[] = [];
  let startRow = 0, startDistance = Infinity;
  centers.forEach((center, row) => {
    const d = distance(center, start);
    if (d < startDistance) { startRow = row; startDistance = d; }
    const before = centers[Math.max(0, row - 1)], after = centers[Math.min(centers.length - 1, row + 1)];
    const dx = after[0] - before[0], dz = after[2] - before[2];
    const length = Math.max(0.001, Math.hypot(dx, dz));
    for (let lane = 0; lane < lanes; lane += 1) {
      const offset = (lane - halfLanes) / halfLanes * halfWidth;
      points.push([center[0] - dz / length * offset, center[1], center[2] + dx / length * offset]);
    }
  });
  const startId = points.length, goalId = startId + 1;
  points.push([...start], [...goal]);
  const costs = new Float64Array(points.length).fill(Infinity);
  const previous = new Int32Array(points.length).fill(-1);
  const visited = new Uint8Array(points.length);
  const validity = new Int8Array(points.length);
  const penalties = new Float64Array(points.length);
  const valid = (id: number) => {
    if (!validity[id]) {
      const risk = options.riskAt(points[id]);
      validity[id] = !risk.blocked && pointInsideWalkableCorridor(points[id], path, edge) ? 1 : -1;
      penalties[id] = risk.fire * 4 + risk.heat * 2 + risk.smoke * 0.4;
    }
    return validity[id] > 0;
  };
  const heap: Array<{ id: number; score: number }> = [];
  const push = (item: { id: number; score: number }) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].score <= item.score) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = item;
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child += 1;
        if (heap[child].score >= last.score) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return top;
  };
  if (options.allowStartLanes) {
    for (let lane = 0; lane < lanes; lane += 1) {
      if (!valid(lane)) continue;
      costs[lane] = 0;
      push({ id: lane, score: distance(points[lane], goal) });
    }
  } else {
    costs[startId] = 0;
    push({ id: startId, score: distance(start, goal) });
  }
  while (heap.length) {
    const { id } = pop();
    if (visited[id]) continue;
    if ((id === goalId || (options.allowGoalLanes && id < startId && Math.floor(id / lanes) === centers.length - 1))
      && (options.goalAllowed?.(points[id]) ?? true)) {
      const result: Vec3[] = [];
      for (let cursor = id; cursor !== -1; cursor = previous[cursor]) result.push(points[cursor]);
      result.reverse();
      const smooth: Vec3[] = [result[0]];
      for (let i = 0; i < result.length - 1;) {
        let next = Math.min(result.length - 1, i + 20);
        while (next > i + 1 && !safeSegment(result[i], result[next])) next -= 1;
        smooth.push(result[next]); i = next;
      }
      return smooth;
    }
    visited[id] = 1;
    const neighbors: number[] = [];
    if (id === startId) {
      for (let row = Math.max(0, startRow - 1); row <= Math.min(centers.length - 1, startRow + 1); row += 1) {
        for (let lane = 0; lane < lanes; lane += 1) neighbors.push(row * lanes + lane);
      }
    } else {
      const row = Math.floor(id / lanes), lane = id % lanes;
      for (let dr = -1; dr <= 1; dr += 1) for (let dl = -1; dl <= 1; dl += 1) {
        if (dr === 0 && dl === 0) continue;
        if (row + dr < 0 || row + dr >= centers.length || lane + dl < 0 || lane + dl >= lanes) continue;
        neighbors.push((row + dr) * lanes + lane + dl);
      }
      if (row === centers.length - 1) neighbors.push(goalId);
    }
    for (const next of neighbors) {
      if (visited[next] || !valid(next) || !safeSegment(points[id], points[next])) continue;
      const nextCost = costs[id] + distance(points[id], points[next]) * (1 + penalties[next]);
      if (nextCost >= costs[next]) continue;
      costs[next] = nextCost;
      previous[next] = id;
      push({ id: next, score: nextCost + distance(points[next], goal) });
    }
  }
  return null;
}
