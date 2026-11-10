/**
 * Everything the narrated math story shows, computed from the simulator's own code at the moment
 * the story starts: the worked example (computeRouteExample → findPath + stepCost), the program's
 * choice for each number of people queuing on the centre stair (findPath with that load reserved),
 * and the fire case (stepCostTerms with the example fire). Nothing here is typed in by hand.
 *
 * Rounding: every substitution shown on screen is checked here — the value computed from the
 * displayed (rounded) inputs must round to the displayed result. Totals are summed from the full
 * values first and rounded only for display.
 */
import { placeNameTh } from "../../simulation/placeNames";
import { computeRouteExample, EXAMPLE_CONFIG, EXAMPLE_GOAL, EXAMPLE_START, EXAMPLE_STAIR_EDGE, type ExampleResult, type RouteCalc, type StepRow } from "../../explain/routeExample";
import { createEvacuationGraph, findPath, stepCost, stepCostTerms } from "../../simulation/graph";
import type { FireSource, SimGraph, Vec3 } from "../../simulation/types";

export const MAX_QUEUE = 40;

let graphCache: SimGraph | null = null;
const graphOf = () => (graphCache ??= createEvacuationGraph());

export interface Substitution {
  /** e.g. "0.28 × 13.2317 + 13.2317 ÷ 0.7260" */
  expression: string;
  /** the displayed inputs */ d: string; v: string;
  /** each term from the displayed inputs */ distanceTerm: string; travel: string;
  result: string;
  /** true when the displayed inputs reproduce the displayed result (checked, not assumed) */
  consistent: boolean;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const fixed = (value: number, digits: number) => value.toFixed(digits);

/** Show d and v with enough digits that 0.28·d + d/v recomputed from them gives the same result to 3 decimals. */
export function substitute(row: StepRow, weight = EXAMPLE_CONFIG.distanceWeight): Substitution {
  for (let digits = 2; digits <= 6; digits++) {
    const d = round(row.d, digits), v = round(row.v, digits);
    const distanceTerm = weight * d, travel = d / v;
    const fromShown = distanceTerm + travel;
    const consistent = fixed(fromShown, 3) === fixed(row.distanceTerm + row.travel, 3);
    if (consistent || digits === 6) {
      return {
        expression: `${weight} × ${fixed(d, digits)} + ${fixed(d, digits)} ÷ ${fixed(v, digits)}`,
        d: fixed(d, digits), v: fixed(v, digits), distanceTerm: fixed(distanceTerm, 3), travel: fixed(travel, 3),
        result: fixed(row.distanceTerm + row.travel, 3), consistent,
      };
    }
  }
  throw new Error("unreachable");
}

export interface QueuePoint {
  load: number;
  /** stepCost summed along route A / route B with this many people reserved on the centre stair */
  costA: number; costB: number;
  /** findPath's own choice with that load */
  programPick: "A" | "B";
  programTotal: number;
}

export interface BlockedEdge { edgeId: string; from: string; to: string; fire: number; blocked: boolean; cost: number; points: [Vec3, Vec3] }

export interface StoryModel {
  example: ExampleResult;
  /** the algorithm in findPath, read from its code: A* with an admissible straight-line estimate */
  algorithm: string;
  nodes: Record<string, { name: string; type: string; position: Vec3 }>;
  routePoints: { A: Vec3[]; B: Vec3[]; fire: Vec3[] };
  /** the step shown in detail for each route */
  detail: { A: { index: number; row: StepRow; sub: Substitution }; B: { index: number; row: StepRow; sub: Substitution } };
  queue: QueuePoint[];
  perPerson: { capacity: number; width: number; length: number; queueTerm: number; crowdTerm: number; value: number };
  breakEven: { hand: number; program: number | null; before: QueuePoint; after: QueuePoint };
  fire: { position: Vec3; radius: number; blocked: BlockedEdge[]; route: RouteCalc | null };
  checks: { totalsMatch: boolean; stepsMatch: boolean; substitutionsConsistent: boolean; breakEvenMatches: boolean; queueCurveMatchesProgram: boolean; fireAvoidsCentre: boolean };
}

const routeCostWithLoad = (graph: SimGraph, route: RouteCalc, load: number) => {
  const reserved = new Map([[EXAMPLE_STAIR_EDGE, load]]);
  return route.rows.reduce((sum, row, index) => sum + stepCost(graph, row.edgeId, route.nodeIds[index], EXAMPLE_CONFIG, [], 0, reserved), 0);
};

let cached: StoryModel | null = null;
export function storyModel(): StoryModel {
  if (cached) return cached;
  const graph = graphOf();
  const example = computeRouteExample();
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes: StoryModel["nodes"] = {};
  const take = (id: string) => { const node = nodeMap.get(id); if (node) nodes[id] = { name: placeNameTh(node.name), type: node.type, position: [...node.position] as Vec3 }; };
  [...example.routeA.nodeIds, ...example.routeB.nodeIds, ...(example.fire.route?.nodeIds ?? []), "sim-stair-center-f2", "sim-stair-left-f2"].forEach(take);
  const pts = (ids: string[]) => ids.map((id) => [...nodeMap.get(id)!.position] as Vec3);

  // The step explained in full: the centre stair on A; on B the long outdoor walk that makes B dearer.
  const indexA = example.routeA.rows.findIndex((row) => row.edgeId === EXAMPLE_STAIR_EDGE);
  const indexB = example.routeB.rows.reduce((best, row, index, rows) => (row.handCost > rows[best].handCost ? index : best), 0);

  const queue: QueuePoint[] = [];
  for (let load = 0; load <= MAX_QUEUE; load++) {
    const path = findPath(graph, EXAMPLE_START, [EXAMPLE_GOAL], EXAMPLE_CONFIG, [], 0, new Map([[EXAMPLE_STAIR_EDGE, load]]))!;
    queue.push({
      load,
      costA: routeCostWithLoad(graph, example.routeA, load), costB: routeCostWithLoad(graph, example.routeB, load),
      programPick: path.edgeIds.includes(EXAMPLE_STAIR_EDGE) ? "A" : "B", programTotal: path.totalCost,
    });
  }
  const stair = graph.edges.find((edge) => edge.id === EXAMPLE_STAIR_EDGE)!;
  const queueTerm = EXAMPLE_CONFIG.timeWeight / Math.max(0.1, stair.capacityPerSecond);
  const crowdTerm = EXAMPLE_CONFIG.congestionWeight / Math.max(1, stair.width * Math.max(4, stair.distance));

  // Fire at the centre stair landing (the same fire as the worked example).
  const landing = nodeMap.get("sim-stair-center-f2")!;
  const fireSource: FireSource = { id: "example-fire", position: [...landing.position], floor: 2, startTime: 0, fireRadius: 2.2, smokeRadius: 5, spreadRate: 0, intensity: 1, enabled: true, wing: "core", origin: "primary", generation: 0, hasSpread: false };
  const blocked: BlockedEdge[] = [];
  example.routeA.rows.forEach((row, index) => {
    const terms = stepCostTerms(graph, row.edgeId, example.routeA.nodeIds[index], EXAMPLE_CONFIG, [fireSource], 0);
    const cost = stepCost(graph, row.edgeId, example.routeA.nodeIds[index], EXAMPLE_CONFIG, [fireSource], 0);
    if (terms && !Number.isFinite(cost)) {
      blocked.push({ edgeId: row.edgeId, from: row.from, to: row.to, fire: terms.fire, blocked: terms.blocked, cost, points: [[...terms.from.position] as Vec3, [...terms.to.position] as Vec3] });
    }
  });

  const subA = substitute(example.routeA.rows[indexA]);
  const subB = substitute(example.routeB.rows[indexB]);
  const before = queue[example.breakEvenHand - 1], after = queue[example.breakEvenHand];
  cached = {
    example,
    algorithm: "A* (ค้นหาแบบ A-star: ต้นทุนสะสม + ค่าคาดการณ์ 0.34 × ระยะตรงถึงจุดรวมพล ซึ่งไม่เกินต้นทุนจริง จึงได้ทางที่ต้นทุนต่ำสุด)",
    nodes,
    routePoints: { A: pts(example.routeA.nodeIds), B: pts(example.routeB.nodeIds), fire: example.fire.route ? pts(example.fire.route.nodeIds) : [] },
    detail: { A: { index: indexA, row: example.routeA.rows[indexA], sub: subA }, B: { index: indexB, row: example.routeB.rows[indexB], sub: subB } },
    queue,
    perPerson: { capacity: stair.capacityPerSecond, width: stair.width, length: stair.distance, queueTerm, crowdTerm, value: queueTerm + crowdTerm },
    breakEven: { hand: example.breakEvenHand, program: example.breakEvenProgram, before, after },
    fire: { position: [...landing.position] as Vec3, radius: fireSource.fireRadius, blocked, route: example.fire.route },
    checks: {
      totalsMatch: Math.abs(example.routeA.total - example.routeA.programTotal) < 1e-9 && Math.abs(example.routeB.total - example.routeB.programTotal) < 1e-9,
      stepsMatch: example.maxStepError < 1e-9,
      substitutionsConsistent: subA.consistent && subB.consistent,
      breakEvenMatches: example.breakEvenHand === example.breakEvenProgram && before.programPick === "A" && after.programPick === "B",
      // the curve drawn from stepCost sums must give the same choice as findPath at every load
      queueCurveMatchesProgram: queue.every((point) => (point.costA <= point.costB ? "A" : "B") === point.programPick),
      fireAvoidsCentre: example.fire.avoidsCentre && blocked.length > 0,
    },
  };
  return cached;
}

/** The program's choice at any load (precomputed 0…MAX_QUEUE). */
export const queueAt = (load: number) => storyModel().queue[Math.max(0, Math.min(MAX_QUEUE, Math.round(load)))];
