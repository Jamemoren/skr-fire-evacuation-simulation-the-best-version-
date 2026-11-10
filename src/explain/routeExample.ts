/**
 * The worked example used by the guide and the presentation: one real case from the school map,
 * computed live from the simulator's own route search (findPath) and step cost (stepCost), so the
 * numbers on screen are the program's — and the hand calculation is checked against them.
 *
 * Case: a student in room 203 (Building 1, floor 2) goes to assembly area Zone C.
 *   Route A — the centre stair; Route B — the left stair (the centre stair excluded).
 *   With nobody queuing, A is cheaper. Each person already planned on the centre stair adds
 *   queue time (people ÷ capacity) and crowding (people ÷ stair area × weight); past a break-even
 *   number the program switches to B. The break-even is computed by hand and checked by search.
 *   Fire variant: a fire at the centre stair landing closes A. Closed variant: every ground-floor
 *   exit closed — no route at all.
 */
import { createEvacuationGraph, findPath, stepCost, stepCostTerms } from "../simulation/graph";
import { placeNameTh } from "../simulation/placeNames";
import type { FireSource, SimGraph, SimulationConfig } from "../simulation/types";

export const EXAMPLE_START = "b1-f2-pink-3";
export const EXAMPLE_GOAL = "sim-zone-c";
export const EXAMPLE_STAIR_EDGE = "edge-stair-center-2-1";

/** The simulator's default settings (runtime DEFAULT_CONFIG), balanced preset. */
export const EXAMPLE_CONFIG: SimulationConfig = {
  populationTarget: 3000, preset: "balanced", walkingSpeed: 1.32, responseDelayMin: 3, responseDelayMax: 10, rerouteInterval: 1.25,
  distanceWeight: 0.28, timeWeight: 1, congestionWeight: 20, fireWeight: 4200, smokeWeight: 1250, fireSpreadEnabled: true,
  crowdBehavior: "grouped", ambientTemperatureC: 29, heatAvoidThresholdC: 44, hardBlockTemperatureC: 62, thermalLookAheadEdges: 10,
  thermalWeight: 2400, seed: 1, decisionMode: "occupant",
};

export interface StepRow {
  edgeId: string; from: string; to: string; kind: string;
  /** metres walked */ d: number; /** m/s = walking speed × passage factor */ v: number;
  /** people already planned on it */ load: number; /** persons per second */ capacity: number;
  /** term values (seconds-equivalent cost units) */ distanceTerm: number; travel: number; queue: number; crowd: number; hazard: number;
  /** what the program adds for this step (stepCost) */ cost: number;
  /** the hand formula's total */ handCost: number;
}
export interface RouteCalc { label: string; nodeIds: string[]; rows: StepRow[]; total: number; programTotal: number; distance: number }

function rowsFor(graph: SimGraph, nodeIds: string[], edgeIds: string[], config: SimulationConfig, fires: FireSource[], reserved: Map<string, number>): StepRow[] {
  return edgeIds.map((edgeId, index) => {
    const t = stepCostTerms(graph, edgeId, nodeIds[index], config, fires, 0, reserved)!;
    const distanceTerm = config.distanceWeight * t.distance;
    const travel = t.travel * config.timeWeight;
    const queue = t.queueDelay * config.timeWeight;
    const crowd = t.density * config.congestionWeight;
    const hazard = t.fire * config.fireWeight + t.heat * config.fireWeight * 0.58 + t.smoke * config.smokeWeight + t.thermalPenalty;
    return {
      edgeId, from: placeNameTh(t.from.name), to: placeNameTh(t.to.name), kind: t.edge.kind, d: t.distance, v: t.speed, load: t.load, capacity: t.capacityPerSecond,
      distanceTerm, travel, queue, crowd, hazard,
      cost: stepCost(graph, edgeId, nodeIds[index], config, fires, 0, reserved),
      handCost: distanceTerm + travel + queue + crowd + hazard,
    };
  });
}

let graphCache: SimGraph | null = null;
const graphOf = () => (graphCache ??= createEvacuationGraph());

export interface ExampleResult {
  config: SimulationConfig;
  routeA: RouteCalc; routeB: RouteCalc;
  /** findPath's choice with nobody queuing */ programPick: "A" | "B";
  /** the hand calculation's choice */ handPick: "A" | "B";
  /** the largest difference between a hand step cost and the program's step cost */ maxStepError: number;
  /** cost added per person queued on the centre stair: 1/capacity + weight / (width × max(4, length)) */ perPerson: number;
  /** people on the centre stair at which the hand calculation says B becomes cheaper */ breakEvenHand: number;
  /** the smallest load at which findPath switches to B */ breakEvenProgram: number | null;
  /** a fire at the centre stair landing (floor 2): the program's route and whether it avoids A */
  fire: { avoidsCentre: boolean; route: RouteCalc | null };
  /** every ground-floor exit of Building 1 closed: the program finds no route */
  allExitsClosed: { route: null | string[] };
  stair: { width: number; length: number; capacity: number; speedFactor: number };
}

/** Compute the whole example (a few milliseconds). */
export function computeRouteExample(config: SimulationConfig = EXAMPLE_CONFIG): ExampleResult {
  const graph = graphOf();
  const reserved = new Map<string, number>();
  const a = findPath(graph, EXAMPLE_START, [EXAMPLE_GOAL], config, [], 0, reserved)!;
  const b = findPath(graph, EXAMPLE_START, [EXAMPLE_GOAL], config, [], 0, reserved, new Set([EXAMPLE_STAIR_EDGE]))!;
  const calc = (label: string, path: typeof a): RouteCalc => {
    const rows = rowsFor(graph, path.nodeIds, path.edgeIds, config, [], reserved);
    return { label, nodeIds: path.nodeIds, rows, total: rows.reduce((sum, row) => sum + row.handCost, 0), programTotal: path.totalCost, distance: path.distance };
  };
  const routeA = calc("A · บันไดกลาง", a), routeB = calc("B · บันไดซ้าย", b);
  const maxStepError = Math.max(...[...routeA.rows, ...routeB.rows].map((row) => Math.abs(row.cost - row.handCost)));
  const stair = graph.edges.find((edge) => edge.id === EXAMPLE_STAIR_EDGE)!;
  const perPerson = config.timeWeight / Math.max(0.1, stair.capacityPerSecond) + config.congestionWeight / Math.max(1, stair.width * Math.max(4, stair.distance));
  const breakEvenHand = Math.floor((routeB.total - routeA.total) / perPerson) + 1;
  let breakEvenProgram: number | null = null;
  for (let load = 1; load <= 200; load += 1) {
    const path = findPath(graph, EXAMPLE_START, [EXAMPLE_GOAL], config, [], 0, new Map([[EXAMPLE_STAIR_EDGE, load]]));
    if (path && !path.edgeIds.includes(EXAMPLE_STAIR_EDGE)) { breakEvenProgram = load; break; }
  }
  // Fire at the centre stair landing on floor 2.
  const landing = graph.nodes.find((node) => node.id === "sim-stair-center-f2")!;
  const fire: FireSource = { id: "example-fire", position: [...landing.position], floor: 2, startTime: 0, fireRadius: 2.2, smokeRadius: 5, spreadRate: 0, intensity: 1, enabled: true, wing: "core", origin: "primary", generation: 0, hasSpread: false };
  const firePath = findPath(graph, EXAMPLE_START, [EXAMPLE_GOAL], config, [fire], 0, new Map());
  const fireRoute = firePath ? { label: "เมื่อมีไฟที่บันไดกลาง", nodeIds: firePath.nodeIds, rows: rowsFor(graph, firePath.nodeIds, firePath.edgeIds, config, [fire], new Map()), total: 0, programTotal: firePath.totalCost, distance: firePath.distance } : null;
  if (fireRoute) fireRoute.total = fireRoute.rows.reduce((sum, row) => sum + row.handCost, 0);
  const exitEdges = new Set(graph.edges.filter((edge) => edge.id.endsWith("-door-exit") && edge.id.startsWith("edge-")).map((edge) => edge.id));
  const closed = findPath(graph, EXAMPLE_START, [EXAMPLE_GOAL], config, [], 0, new Map(), exitEdges);
  return {
    config, routeA, routeB,
    programPick: a.edgeIds.includes(EXAMPLE_STAIR_EDGE) ? "A" : "B",
    handPick: routeA.total <= routeB.total ? "A" : "B",
    maxStepError, perPerson, breakEvenHand, breakEvenProgram,
    fire: { avoidsCentre: !!firePath && !firePath.edgeIds.includes(EXAMPLE_STAIR_EDGE), route: fireRoute },
    allExitsClosed: { route: closed ? closed.nodeIds : null },
    stair: { width: stair.width, length: stair.distance, capacity: stair.capacityPerSecond, speedFactor: stair.speedMultiplier },
  };
}

export const fmt = (value: number, digits = 2) => value.toLocaleString("th-TH", { minimumFractionDigits: digits, maximumFractionDigits: digits });
