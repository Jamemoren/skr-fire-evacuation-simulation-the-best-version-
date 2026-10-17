import {
  ASSEMBLY_ZONE_CAPACITY,
  ASSEMBLY_ZONE_OFFSETS,
  CLASSROOMS,
  FLOOR_COUNT,
  STAIR_ZONE_CENTERS,
  TARGET_POPULATION,
  TOTAL_CLASSROOMS,
} from "../building1/building1Data";
import { createEvacuationGraph, findPath, routeIsPhysicallyValid } from "./graph";
import type { SimulationConfig } from "./types";

export interface OperationalCheck {
  id: "building" | "population" | "portals" | "stairs" | "assembly" | "routes";
  label: string;
  detail: string;
  passed: boolean;
}

export interface OperationalReadinessReport {
  ready: boolean;
  passed: number;
  total: number;
  checkedAt: number;
  checks: OperationalCheck[];
}

const PREFLIGHT_CONFIG: SimulationConfig = {
  populationTarget: TARGET_POPULATION,
  preset: "balanced",
  walkingSpeed: 1.32,
  responseDelayMin: 3,
  responseDelayMax: 10,
  rerouteInterval: 2,
  distanceWeight: 0.28,
  timeWeight: 1,
  congestionWeight: 20,
  fireWeight: 4200,
  smokeWeight: 1250,
  fireSpreadEnabled: true,
  crowdBehavior: "grouped",
  ambientTemperatureC: 29,
  heatAvoidThresholdC: 44,
  hardBlockTemperatureC: 62,
  thermalLookAheadEdges: 10,
  thermalWeight: 2400,
};

/**
 * Performs a deterministic client-side pre-flight before operators can start a drill.
 * This complements the build-time QA by verifying the exact graph shipped to the browser.
 */
export function evaluateOperationalReadiness(): OperationalReadinessReport {
  const graph = createEvacuationGraph();
  const assemblyNodes = graph.nodes.filter((node) => node.type === "assembly");
  const goalIds = assemblyNodes.map((node) => node.id);
  const roomFloors = new Map<number, number>();
  CLASSROOMS.forEach((room) => roomFloors.set(room.floor, (roomFloors.get(room.floor) ?? 0) + 1));
  const roomDoorCoverage = CLASSROOMS.filter((room) => graph.edges.some((edge) => (
    edge.kind === "room" && (edge.from === room.id || edge.to === room.id)
  ))).length;
  const stairNodes = graph.nodes.filter((node) => node.type === "stair");
  const stairExitPortals = graph.nodes.filter((node) => node.type === "door" && node.id.startsWith("sim-stair-exit-door-"));

  let validRoutes = 0;
  for (const room of CLASSROOMS) {
    const path = findPath(graph, room.id, goalIds, PREFLIGHT_CONFIG, [], 0);
    if (path && routeIsPhysicallyValid(graph, path)) validRoutes += 1;
  }

  const checks: OperationalCheck[] = [
    {
      id: "building",
      label: "9-FLOOR MODEL",
      detail: `${FLOOR_COUNT} ชั้น · ${TOTAL_CLASSROOMS} ห้อง`,
      passed: FLOOR_COUNT === 9 && CLASSROOMS.length === TOTAL_CLASSROOMS
        && Array.from({ length: 8 }, (_, index) => roomFloors.get(index + 2) === 12).every(Boolean),
    },
    {
      id: "population",
      label: "POPULATION",
      detail: `${CLASSROOMS.reduce((sum, room) => sum + room.peopleCount, 0).toLocaleString("th-TH")} คน`,
      passed: CLASSROOMS.reduce((sum, room) => sum + room.peopleCount, 0) === TARGET_POPULATION,
    },
    {
      id: "portals",
      label: "VERIFIED DOORS",
      detail: `${roomDoorCoverage}/${TOTAL_CLASSROOMS} ห้อง`,
      passed: roomDoorCoverage === TOTAL_CLASSROOMS,
    },
    {
      id: "stairs",
      label: "STAIR NETWORK",
      detail: `${Object.keys(STAIR_ZONE_CENTERS).length} โซน · ${stairNodes.length} nodes`,
      passed: stairNodes.length === FLOOR_COUNT * 3 && stairExitPortals.length === 3,
    },
    {
      id: "assembly",
      label: "ASSEMBLY CAPACITY",
      detail: `${ASSEMBLY_ZONE_OFFSETS.length} × ${ASSEMBLY_ZONE_CAPACITY.toLocaleString("th-TH")}`,
      passed: assemblyNodes.length === ASSEMBLY_ZONE_OFFSETS.length
        && assemblyNodes.reduce((sum, node) => sum + node.capacity, 0) === TARGET_POPULATION,
    },
    {
      id: "routes",
      label: "PHYSICAL ROUTES",
      detail: `${validRoutes}/${TOTAL_CLASSROOMS} ถึงสนาม`,
      passed: validRoutes === TOTAL_CLASSROOMS,
    },
  ];
  const passed = checks.filter((check) => check.passed).length;
  return { ready: passed === checks.length, passed, total: checks.length, checkedAt: Date.now(), checks };
}
