import {
  ASSEMBLY_ZONE_OFFSETS,
  CLASSROOMS,
  FIELD_ASSEMBLY,
  FIELD_CENTER,
  FLOOR_COUNT,
  FLOOR_HEIGHT,
  TOTAL_HEIGHT,
} from "../../building1/building1Data";
import { findPath, traversalPoints } from "../../simulation/graph";
import { evacuationRuntime } from "../../simulation/runtime";
import type { RoutePath, SimEdgeKind, SimGraph, SimNode, Vec3 } from "../../simulation/types";
import { INTRO_SPARK_POINT } from "./introCamera";

export interface Polyline {
  points: Vec3[];
  /** Seconds (story time) when this line starts drawing, and how long it takes. */
  drawStart: number;
  drawDuration: number;
  color: string;
  /** Trail phase offset in metres so parallel paths do not pulse in lockstep. */
  phase?: number;
}

export interface IntroRoute {
  roomId: string;
  floor: number;
  points: Vec3[];
  length: number;
  exitName: string;
}

export interface IntroAnchor {
  id: "building" | "bottleneck" | "alternative" | "assembly";
  position: Vec3;
  title: string;
  detail: string;
}

export interface IntroData {
  blueprint: Polyline[];
  sparkRays: Polyline[];
  edgeRunners: Polyline[];
  fieldLines: Polyline[];
  networkEdges: Array<{ points: Vec3[]; kind: SimEdgeKind }>;
  networkNodes: Array<{ position: Vec3; type: SimNode["type"] }>;
  primaryRoutes: IntroRoute[];
  alternativeRoutes: IntroRoute[];
  assemblyFlows: Vec3[][];
  bottleneck: { id: string; name: string; position: Vec3 };
  assemblyCenter: Vec3;
  anchors: IntroAnchor[];
  roofY: number;
}

// Footprints taken from the generated model's own slab/tower dimensions.
const FOOTPRINTS: Array<{ id: string; x: [number, number]; z: [number, number] }> = [
  { id: "pink-wing", x: [-52.3, -3.7], z: [-10, 3.7] },
  { id: "blue-wing", x: [-3.6, 10.1], z: [3.7, 52.3] },
  { id: "rear-core", x: [-3.65, 9.88], z: [-9.88, 3.65] },
  { id: "pink-tower", x: [-60.45, -51.95], z: [-10.75, 4.25] },
  { id: "blue-tower", x: [-4.25, 10.75], z: [51.95, 60.45] },
];
const NOSE_RADIUS = 8.15;

const COLORS = {
  structure: "#2f8bff",
  structureBright: "#45d6ff",
  violet: "#8a5bff",
  magenta: "#ff3fb4",
  gold: "#ffc24a",
  mint: "#3cf2b0",
  orange: "#ff8a2a",
  cyan: "#38e8ff",
};
export const INTRO_COLORS = COLORS;

const dist2 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

function rectLoop(x: [number, number], z: [number, number], y: number): Vec3[] {
  return [[x[0], y, z[0]], [x[1], y, z[0]], [x[1], y, z[1]], [x[0], y, z[1]], [x[0], y, z[0]]];
}

function noseArc(y: number, segments = 14): Vec3[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / segments);
    return [Math.sin(a) * NOSE_RADIUS, y, Math.cos(a) * NOSE_RADIUS] as Vec3;
  });
}

function stadiumLoop(center: Vec3, straightHalf: number, radius: number, y: number, segments = 28): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = -Math.PI / 2 + (Math.PI * i) / segments;
    points.push([center[0] + straightHalf + Math.cos(a) * radius, y, center[2] + Math.sin(a) * radius]);
  }
  for (let i = 0; i <= segments; i += 1) {
    const a = Math.PI / 2 + (Math.PI * i) / segments;
    points.push([center[0] - straightHalf + Math.cos(a) * radius, y, center[2] + Math.sin(a) * radius]);
  }
  points.push(points[0]);
  return points;
}

function circle(center: Vec3, radius: number, y: number, segments = 40): Vec3[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = (Math.PI * 2 * i) / segments;
    return [center[0] + Math.cos(a) * radius, y, center[2] + Math.sin(a) * radius] as Vec3;
  });
}

/** Blueprint draw-on order radiates from the spark and climbs floor by floor. */
function sparkTiming(points: Vec3[], base = 0.34, speed = 92): { drawStart: number; drawDuration: number } {
  const centre = points.reduce<Vec3>((acc, p) => [acc[0] + p[0] / points.length, acc[1] + p[1] / points.length, acc[2] + p[2] / points.length], [0, 0, 0]);
  const length = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1], p[2] - points[i][2]), 0);
  return {
    drawStart: base + dist2(centre, INTRO_SPARK_POINT) / speed + (centre[1] / TOTAL_HEIGHT) * 0.5,
    drawDuration: Math.min(0.55, Math.max(0.14, length / 120)),
  };
}

function buildBlueprint(): Polyline[] {
  const lines: Polyline[] = [];
  for (let floor = 0; floor <= FLOOR_COUNT; floor += 1) {
    const y = floor * FLOOR_HEIGHT + 0.05;
    const major = floor === 0 || floor === FLOOR_COUNT;
    for (const fp of FOOTPRINTS) {
      const points = rectLoop(fp.x, fp.z, y);
      lines.push({ points, ...sparkTiming(points), color: major ? COLORS.structureBright : COLORS.structure });
    }
    const nose = noseArc(y);
    lines.push({ points: nose, ...sparkTiming(nose), color: major ? COLORS.cyan : COLORS.violet });
  }
  // Vertical arrises and the courtyard column rhythm (8 m bays).
  const verticals: Vec3[] = [];
  for (const fp of FOOTPRINTS) {
    verticals.push([fp.x[0], 0, fp.z[0]], [fp.x[1], 0, fp.z[0]], [fp.x[1], 0, fp.z[1]], [fp.x[0], 0, fp.z[1]]);
  }
  for (let x = -4; x >= -52; x -= 8) verticals.push([x, 0, 3.7]);
  for (let z = 4; z <= 52; z += 8) verticals.push([-3.6, 0, z]);
  for (const base of verticals) {
    const top: Vec3 = [base[0], TOTAL_HEIGHT + 0.05, base[2]];
    const timing = sparkTiming([base, base], 0.42);
    lines.push({ points: [base, top], drawStart: timing.drawStart, drawDuration: 0.62, color: COLORS.structure });
  }
  return lines;
}

function buildFieldLines(): Polyline[] {
  const c = FIELD_CENTER;
  const y = 0.32;
  const lines: Polyline[] = [];
  const push = (points: Vec3[], color: string) => lines.push({ points, ...sparkTiming(points, 0.3), color });
  push(rectLoop([c[0] - 52, c[0] + 52], [c[2] - 31, c[2] + 31], y), COLORS.structure);
  push(stadiumLoop(c, 22, 25, y), COLORS.violet);
  push(stadiumLoop(c, 22, 17, y), COLORS.structure);
  push(rectLoop([c[0] - 31, c[0] + 31], [c[2] - 15, c[2] + 15], y + 0.02), COLORS.structureBright);
  push([[c[0], y + 0.02, c[2] - 15], [c[0], y + 0.02, c[2] + 15]], COLORS.structureBright);
  push(circle(c, 9.15, y + 0.02), COLORS.structureBright);
  return lines;
}

function buildSparkRays(): Polyline[] {
  const s: Vec3 = [INTRO_SPARK_POINT[0], 0.12, INTRO_SPARK_POINT[2]];
  const targets: Array<[Vec3, string]> = [
    [[-5.5, 0.12, 5.5], COLORS.cyan],
    [[-55, 0.12, 6], COLORS.magenta],
    [[4, 0.12, 54], COLORS.violet],
    [[FIELD_CENTER[0], 0.12, 66], COLORS.gold],
  ];
  return targets.map(([target, color], index) => ({
    points: [s, target],
    drawStart: 0.18 + index * 0.05,
    drawDuration: 0.55 + dist2(s, target) / 260,
    color,
    phase: index * 17,
  }));
}

function buildEdgeRunners(): Polyline[] {
  const roof = TOTAL_HEIGHT + 0.12;
  const runners: Polyline[] = [];
  const palette = [COLORS.magenta, COLORS.cyan, COLORS.gold, COLORS.violet, COLORS.cyan];
  FOOTPRINTS.forEach((fp, index) => {
    runners.push({ points: rectLoop(fp.x, fp.z, roof), drawStart: 0, drawDuration: 0.01, color: palette[index], phase: index * 23 });
    runners.push({ points: rectLoop(fp.x, fp.z, FLOOR_HEIGHT + 0.08), drawStart: 0, drawDuration: 0.01, color: palette[(index + 2) % palette.length], phase: index * 31 + 9 });
  });
  runners.push({ points: noseArc(roof, 18), drawStart: 0, drawDuration: 0.01, color: COLORS.gold, phase: 5 });
  return runners;
}

function routePolyline(graph: SimGraph, nodeMap: Map<string, SimNode>, path: RoutePath): Vec3[] {
  const edgeMap = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const points: Vec3[] = [];
  path.edgeIds.forEach((edgeId, index) => {
    const edge = edgeMap.get(edgeId);
    if (!edge) return;
    for (const p of traversalPoints(edge, nodeMap, path.nodeIds[index], path.nodeIds[index + 1])) {
      const last = points[points.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 0.05) points.push([p[0], p[1] + 0.18, p[2]]);
    }
  });
  return points;
}

function polylineLength(points: Vec3[]) {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  return length;
}

function exitNameOf(path: RoutePath, nodeMap: Map<string, SimNode>): string {
  const exit = path.nodeIds.map((id) => nodeMap.get(id)).find((node) => node?.type === "exit");
  return exit?.name ?? "ทางออก";
}

/**
 * Everything the intelligence beat shows comes from the simulator's own evacuation graph:
 * baseline shortest routes (no fire, no queue) for every classroom, the node most of
 * those routes share, and the route each room would take with that stair excluded.
 * It is an illustration of the method — no simulated outcome numbers are displayed.
 */
function buildRouteStory(graph: SimGraph) {
  const config = evacuationRuntime.config;
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const goals = graph.nodes.filter((node) => node.type === "assembly").map((node) => node.id);
  const baseline = new Map<string, RoutePath>();
  const usage = new Map<string, number>();
  for (const room of CLASSROOMS) {
    const path = findPath(graph, room.id, goals, config, [], 0);
    if (!path) continue;
    baseline.set(room.id, path);
    path.nodeIds.forEach((id) => usage.set(id, (usage.get(id) ?? 0) + 1));
  }

  const candidates = graph.nodes
    .filter((node) => (node.type === "stair" || node.type === "exit") && node.floor <= 1)
    .sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || (a.type === "stair" ? -1 : 1));
  const bottleneckNode = candidates[0] ?? graph.nodes.find((node) => node.type === "exit") ?? graph.nodes[0];

  const through = CLASSROOMS
    .filter((room) => baseline.get(room.id)?.nodeIds.includes(bottleneckNode.id))
    .sort((a, b) => b.floor - a.floor || a.id.localeCompare(b.id));
  // Spread the illustrated rooms over floors and both wings.
  const picked: typeof through = [];
  const usedFloors = new Map<number, number>();
  for (const room of through) {
    const count = usedFloors.get(room.floor) ?? 0;
    if (count >= 1 || picked.length >= 8) continue;
    usedFloors.set(room.floor, count + 1);
    picked.push(room);
  }

  const primaryRoutes: IntroRoute[] = picked.map((room) => {
    const path = baseline.get(room.id)!;
    const points = routePolyline(graph, nodeMap, path);
    return { roomId: room.id, floor: room.floor, points, length: polylineLength(points), exitName: exitNameOf(path, nodeMap) };
  });

  const zonePrefix = bottleneckNode.id.match(/^(.*-)f\d+$/)?.[1];
  const excludedNodes = new Set(graph.nodes.filter((node) => (zonePrefix ? node.id.startsWith(zonePrefix) : node.id === bottleneckNode.id)).map((node) => node.id));
  const excluded = new Set(graph.edges.filter((edge) => excludedNodes.has(edge.from) || excludedNodes.has(edge.to)).map((edge) => edge.id));
  const alternativeRoutes: IntroRoute[] = [];
  const exitsUsed = new Map<string, number>();
  for (const room of through) {
    if (alternativeRoutes.length >= 4) break;
    const path = findPath(graph, room.id, goals, config, [], 0, new Map(), excluded);
    if (!path) continue;
    const exitName = exitNameOf(path, nodeMap);
    if ((exitsUsed.get(exitName) ?? 0) >= 2) continue;
    exitsUsed.set(exitName, (exitsUsed.get(exitName) ?? 0) + 1);
    const points = routePolyline(graph, nodeMap, path);
    alternativeRoutes.push({ roomId: room.id, floor: room.floor, points, length: polylineLength(points), exitName });
  }

  // Alternative stair label: the stair node of the first alternative route nearest mid-height.
  const altPath = alternativeRoutes[0] ? findPath(graph, alternativeRoutes[0].roomId, goals, config, [], 0, new Map(), excluded) : null;
  const altStairs = (altPath?.nodeIds ?? []).map((id) => nodeMap.get(id)).filter((node): node is SimNode => node?.type === "stair");
  const altStair = altStairs.sort((a, b) => Math.abs(a.floor - 5) - Math.abs(b.floor - 5))[0] ?? null;

  return { bottleneckNode, primaryRoutes, alternativeRoutes, altStair, nodeMap };
}

export function buildIntroData(): IntroData {
  const graph = evacuationRuntime.graph;
  const story = buildRouteStory(graph);
  const networkEdges = graph.edges
    .filter((edge) => edge.insideBuilding || edge.kind === "exit")
    .map((edge) => ({ points: traversalPoints(edge, story.nodeMap, edge.from, edge.to).map((p) => [p[0], p[1] + 0.1, p[2]] as Vec3), kind: edge.kind }))
    .filter((edge) => edge.points.length >= 2);
  const networkNodes = graph.nodes
    .filter((node) => node.floor >= 1)
    .map((node) => ({ position: [node.position[0], node.position[1] + 0.12, node.position[2]] as Vec3, type: node.type }));
  const assemblyFlows = graph.edges
    .filter((edge) => edge.kind === "outdoor" || edge.kind === "assembly")
    .map((edge) => traversalPoints(edge, story.nodeMap, edge.from, edge.to).map((p) => [p[0], 0.35, p[2]] as Vec3))
    .filter((points) => points.length >= 2);

  const b = story.bottleneckNode;
  const alt = story.altStair;
  const assemblyCenter: Vec3 = [FIELD_CENTER[0], 0.4, FIELD_CENTER[2]];
  const anchors: IntroAnchor[] = [
    { id: "building", position: [0, TOTAL_HEIGHT + 1.5, 0], title: "อาคารเรียน 1", detail: `${FLOOR_COUNT} ชั้น · ${CLASSROOMS.length} ห้องเรียน` },
    { id: "bottleneck", position: [b.position[0], b.position[1] + 1.2, b.position[2]], title: "จุดเสี่ยงคอขวด", detail: `${b.name} · เส้นทางหลักมาบรรจบ` },
    ...(alt ? [{ id: "alternative" as const, position: [alt.position[0], alt.position[1] + 1.2, alt.position[2]] as Vec3, title: "ทางเลือกที่กระจายภาระ", detail: alt.name.replace(/ ชั้น \d+$/, "") }] : []),
    { id: "assembly", position: assemblyCenter, title: "จุดรวมพล", detail: `${FIELD_ASSEMBLY.name.split("/")[0].trim()} · ${ASSEMBLY_ZONE_OFFSETS.length} โซนรวมพล` },
  ];

  return {
    blueprint: buildBlueprint(),
    sparkRays: buildSparkRays(),
    edgeRunners: buildEdgeRunners(),
    fieldLines: buildFieldLines(),
    networkEdges,
    networkNodes,
    primaryRoutes: story.primaryRoutes,
    alternativeRoutes: story.alternativeRoutes,
    assemblyFlows,
    bottleneck: { id: b.id, name: b.name, position: [b.position[0], b.position[1], b.position[2]] },
    assemblyCenter,
    anchors,
    roofY: TOTAL_HEIGHT,
  };
}

let cachedIntroData: IntroData | null = null;
/** The evacuation graph is static, so the illustration is derived once per page load. */
export function getIntroData(): IntroData {
  cachedIntroData ??= buildIntroData();
  return cachedIntroData;
}
