/**
 * Routing service for the mobile guidance. Deterministic and testable (no LLM, no randomness):
 *  1. eligibility first — an edge is usable only if it exists, is walked in an allowed direction,
 *     is not closed, is not inside a sensor-blocked area, and suits the participant's mobility;
 *  2. then cost — walking time + clearance time of the people already advised onto the same
 *     passage + a margin near (not inside) a sensed hazard;
 *  3. one reverse Dijkstra "field" from all assembly points per (revision, profile, load step),
 *     so 3,000 participants never trigger 3,000 searches;
 *  4. a participant keeps their current route while it stays eligible and is not clearly worse
 *     (hysteresis), and changes immediately when it becomes ineligible.
 * Load-balancing weights never make a forbidden edge usable: forbidden edges are removed before
 * any cost is considered.
 */
import type { SimEdge, SimNode } from "../simulation/types";
import type { MapRegistry } from "./mapRegistry";

export type MobilityProfile = "standard" | "no-stairs";

export interface RoutingConstraints {
  closedEdges: ReadonlySet<string>;
  /** Edges inside an area where a sensor measured a hazard (assumed impassable). */
  hazardBlockedEdges: ReadonlySet<string>;
  /** Edges near a hazard: allowed, but cost a margin (seconds). */
  hazardMarginEdges: ReadonlyMap<string, number>;
  /** Participants currently advised onto each edge (load). */
  edgeLoad: ReadonlyMap<string, number>;
  /** Participants currently advised to each assembly point. */
  assemblyLoad: ReadonlyMap<string, number>;
}

/** Walking speed used for estimates (m/s): calm evacuation walking, not running. Assumption. */
export const WALK_SPEED = 1.2;
/** Weight of the "people already advised here" clearance time in the cost. */
export const LOAD_WEIGHT = 0.6;

export function edgeEligible(edge: SimEdge, profile: MobilityProfile, constraints: RoutingConstraints): boolean {
  if (constraints.closedEdges.has(edge.id)) return false;
  if (constraints.hazardBlockedEdges.has(edge.id)) return false;
  if (profile === "no-stairs" && edge.kind === "stair") return false;
  return true;
}

export function edgeCost(edge: SimEdge, constraints: RoutingConstraints, excludeSelf = 0): number {
  const walk = edge.distance / (WALK_SPEED * Math.max(0.3, edge.speedMultiplier || 1));
  const load = Math.max(0, (constraints.edgeLoad.get(edge.id) ?? 0) - excludeSelf);
  const clearance = load / Math.max(0.2, edge.capacityPerSecond);
  return walk + LOAD_WEIGHT * clearance + (constraints.hazardMarginEdges.get(edge.id) ?? 0);
}

export interface RouteField {
  profile: MobilityProfile;
  cost: Map<string, number>;
  /** For each node: the edge to take next and the node it leads to. */
  next: Map<string, { edgeId: string; nodeId: string }>;
}

interface ReverseIndex { incoming: Map<string, Array<{ edge: SimEdge; from: string }>> }
const reverseCache = new WeakMap<MapRegistry, ReverseIndex>();

function reverseIndex(registry: MapRegistry): ReverseIndex {
  const cached = reverseCache.get(registry);
  if (cached) return cached;
  const incoming = new Map<string, Array<{ edge: SimEdge; from: string }>>();
  const add = (to: string, from: string, edge: SimEdge) => (incoming.get(to) ?? incoming.set(to, []).get(to)!).push({ edge, from });
  for (const edge of registry.graph.edges) {
    add(edge.to, edge.from, edge);
    if (edge.twoWay) add(edge.from, edge.to, edge);
  }
  const index = { incoming };
  reverseCache.set(registry, index);
  return index;
}

class MinHeap {
  private items: Array<[number, string]> = [];
  get size() { return this.items.length; }
  push(cost: number, id: string) {
    const items = this.items; items.push([cost, id]);
    let i = items.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (items[p][0] <= items[i][0]) break; [items[p], items[i]] = [items[i], items[p]]; i = p; }
  }
  pop(): [number, string] | undefined {
    const items = this.items; if (!items.length) return undefined;
    const top = items[0]; const last = items.pop()!;
    if (items.length) {
      items[0] = last; let i = 0;
      for (;;) { const l = i * 2 + 1, r = l + 1; let m = i;
        if (l < items.length && items[l][0] < items[m][0]) m = l;
        if (r < items.length && items[r][0] < items[m][0]) m = r;
        if (m === i) break; [items[m], items[i]] = [items[i], items[m]]; i = m; }
    }
    return top;
  }
}

/** Seconds of extra cost for an assembly point that is already full in the advice plan. */
function assemblyPenalty(node: SimNode, constraints: RoutingConstraints) {
  const load = constraints.assemblyLoad.get(node.id) ?? 0;
  return load >= node.capacity ? 600 : (load / Math.max(1, node.capacity)) * 20;
}

export function computeRouteField(registry: MapRegistry, profile: MobilityProfile, constraints: RoutingConstraints): RouteField {
  const { incoming } = reverseIndex(registry);
  const cost = new Map<string, number>();
  const next = new Map<string, { edgeId: string; nodeId: string }>();
  const heap = new MinHeap();
  for (const goal of registry.assemblies) {
    const start = assemblyPenalty(goal, constraints);
    cost.set(goal.id, start);
    heap.push(start, goal.id);
  }
  while (heap.size) {
    const [c, nodeId] = heap.pop()!;
    if (c > (cost.get(nodeId) ?? Infinity)) continue;
    for (const { edge, from } of incoming.get(nodeId) ?? []) {
      if (!edgeEligible(edge, profile, constraints)) continue;
      const candidate = c + edgeCost(edge, constraints);
      if (candidate < (cost.get(from) ?? Infinity)) {
        cost.set(from, candidate);
        next.set(from, { edgeId: edge.id, nodeId });
        heap.push(candidate, from);
      }
    }
  }
  return { profile, cost, next };
}

export interface PathResult { nodeIds: string[]; edgeIds: string[]; cost: number; goalId: string }

export function pathFromField(field: RouteField, startNodeId: string, registry: MapRegistry): PathResult | null {
  if (!field.cost.has(startNodeId)) return null;
  const nodeIds = [startNodeId];
  const edgeIds: string[] = [];
  let current = startNodeId;
  const guard = registry.graph.nodes.length + 2;
  while (field.next.has(current)) {
    const step = field.next.get(current)!;
    edgeIds.push(step.edgeId);
    nodeIds.push(step.nodeId);
    current = step.nodeId;
    if (nodeIds.length > guard) return null;
  }
  const goal = registry.nodeMap.get(current);
  if (!goal || goal.type !== "assembly") return null;
  return { nodeIds, edgeIds, cost: field.cost.get(startNodeId)!, goalId: current };
}

/** Is a (remaining) route still usable under the current constraints? Returns the first bad edge. */
export function firstIneligibleEdge(edgeIds: string[], nodeIds: string[], profile: MobilityProfile, registry: MapRegistry, constraints: RoutingConstraints): SimEdge | "invalid" | null {
  for (let index = 0; index < edgeIds.length; index += 1) {
    const edge = registry.edgeMap.get(edgeIds[index]);
    if (!edge) return "invalid";
    const from = nodeIds[index], to = nodeIds[index + 1];
    const forward = edge.from === from && edge.to === to;
    const backward = edge.twoWay && edge.to === from && edge.from === to;
    if (!forward && !backward) return "invalid";
    if (!edgeEligible(edge, profile, constraints)) return edge;
  }
  return null;
}

export function routeCost(edgeIds: string[], goalId: string, registry: MapRegistry, constraints: RoutingConstraints, selfOnRoute: boolean): number {
  let total = 0;
  for (const edgeId of edgeIds) {
    const edge = registry.edgeMap.get(edgeId);
    if (!edge) return Infinity;
    total += edgeCost(edge, constraints, selfOnRoute ? 1 : 0);
  }
  const goal = registry.nodeMap.get(goalId);
  return total + (goal ? assemblyPenalty(goal, constraints) : 0);
}

/** Keep the current route unless the best one is better by this much (hysteresis). */
export function clearlyBetter(currentCost: number, bestCost: number): boolean {
  return bestCost < currentCost * 0.85 - 10;
}
