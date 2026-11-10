/**
 * Registry binding the evacuation graph (the same one the 3D simulator routes on) to buildings,
 * floors, zones, QR checkpoints, simulated sensors and assembly points, under one mapVersion.
 * Pure TypeScript: used by the backend and the dashboard; phones receive it as a MapPackage.
 */
import { activeRoomPopulation, createEvacuationGraph } from "../simulation/graph";
import { nodeBuilding, reportZoneOf } from "../simulation/agentPerception";
import { hashString } from "../simulation/seededRandom";
import type { SimEdge, SimGraph, SimNode } from "../simulation/types";
import type { MapPackage, SensorInfo, SensorType } from "./protocol";
import { BRIDGE_EDGE_ID, BRIDGE_LABEL_TH } from "../simulation/bridge";

export const BUILDING_NAMES: Record<string, string> = {
  "building-1": "อาคาร 1",
  "building-3": "อาคาร 3",
  "building-4": "อาคาร 4",
  site: "พื้นที่ภายนอกอาคาร",
};

const GATE_NAMES: Record<string, string> = {
  "Assembly Gate Left": "ประตูสนาม ฝั่งซ้าย",
  "Assembly Gate Center": "ประตูสนาม ตรงกลาง",
  "Assembly Gate Right": "ประตูสนาม ฝั่งขวา",
};

const WING_NAMES: Record<string, string> = { pink: "ปีกซ้าย", blue: "ปีกขวา", core: "แกนกลาง", "building-3": "ระเบียง", "building-4": "ระเบียง" };

export interface CheckpointEntry {
  id: string;
  nodeId: string;
  buildingId: string;
  floor: number;
  zoneId: string | null;
  name: string;
  kind: string;
}

export interface MapRegistry {
  mapVersion: string;
  graph: SimGraph;
  nodeMap: Map<string, SimNode>;
  edgeMap: Map<string, SimEdge>;
  buildingOf: Map<string, string>;
  zoneOf: Map<string, string | null>;
  checkpoints: CheckpointEntry[];
  checkpointById: Map<string, CheckpointEntry>;
  checkpointByNode: Map<string, CheckpointEntry>;
  sensors: SensorInfo[];
  assemblies: SimNode[];
  zoneLabels: Map<string, string>;
  /** Planned headcount per room node (the school's room allocation used by the simulator). */
  plannedByRoom: Map<string, number>;
}

export function displayNodeName(node: SimNode | undefined): string {
  if (!node) return "ไม่ทราบตำแหน่ง";
  return GATE_NAMES[node.name] ?? node.name;
}

/** "บันไดซ้าย ชั้น 5" → "บันไดซ้าย", "บันได 1 อาคาร 3 ชั้น 2" → "บันได 1 อาคาร 3". */
export function stairBaseName(node: SimNode | undefined): string {
  return displayNodeName(node).replace(/\s*ชั้น\s*\d+$/, "");
}

export function zoneLabel(zoneId: string | null): string {
  if (!zoneId) return "ไม่ทราบโซน";
  const [building, floor, wing] = zoneId.split(":");
  if (building === "site") return BUILDING_NAMES.site;
  const wingName = WING_NAMES[wing] ?? "";
  return `${BUILDING_NAMES[building] ?? building} ชั้น ${floor}${wingName && building === "building-1" ? ` ${wingName}` : ""}`;
}

export function computeMapVersion(graph: SimGraph): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  const nodes = graph.nodes.map((n) => `${n.id}@${n.type}:${n.floor}:${r(n.position[0])},${r(n.position[1])},${r(n.position[2])}`).sort().join("|");
  const edges = graph.edges.map((e) => `${e.id}:${e.from}>${e.to}:${e.twoWay ? 2 : 1}:${r(e.width)}`).sort().join("|");
  const a = hashString(nodes).toString(36).padStart(7, "0");
  const b = hashString(edges).toString(36).padStart(7, "0");
  return `skr-map-${a}${b}`;
}

const CHECKPOINT_TYPES = new Set(["room", "corridor", "junction", "stair", "exit", "gate", "assembly"]);

function buildingCode(buildingId: string) {
  return buildingId === "building-1" ? "B1" : buildingId === "building-3" ? "B3" : buildingId === "building-4" ? "B4" : "OUT";
}

function buildSensors(graph: SimGraph, buildingOf: Map<string, string>, zoneOf: Map<string, string | null>): SensorInfo[] {
  const sensors: SensorInfo[] = [];
  const byZone = new Map<string, SimNode[]>();
  for (const node of graph.nodes) {
    if (node.type !== "corridor" && node.type !== "junction") continue;
    const zone = zoneOf.get(node.id);
    if (!zone || zone.startsWith("site")) continue;
    (byZone.get(zone) ?? byZone.set(zone, []).get(zone)!).push(node);
  }
  const add = (type: SensorType, node: SimNode, suffix: string, label: string) => {
    const buildingId = buildingOf.get(node.id) ?? "site";
    sensors.push({
      sensorId: `SIM-${buildingCode(buildingId)}-F${node.floor}-${suffix}`,
      type, buildingId, floor: node.floor, zoneId: zoneOf.get(node.id) ?? `${buildingId}:${node.floor}:-`, nodeId: node.id, label, simulatedOnly: true,
    });
  };
  [...byZone.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([zone, nodes]) => {
    const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    const middle = sorted[Math.floor(sorted.length / 2)];
    const wing = zone.split(":")[2] ?? "";
    add("smoke", middle, `${wing.toUpperCase().replace(/[^A-Z0-9]/g, "")}-SMK`, `ตรวจจับควัน ${zoneLabel(zone)}`);
  });
  for (const node of graph.nodes) {
    if (node.type !== "stair" || node.floor < 1) continue;
    const zoneTag = node.id.replace(/^sim-stair-|^campus-/, "").replace(/-f\d+$/, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    add("manual-call-point", node, `${zoneTag}-MCP`, `จุดกดแจ้งเหตุ ${displayNodeName(node)}`);
  }
  const bridgeEdge = graph.edges.find((edge) => edge.id === BRIDGE_EDGE_ID);
  const bridgeNode = bridgeEdge ? graph.nodes.find((node) => node.id === bridgeEdge.from) : undefined;
  if (bridgeNode) add("heat", bridgeNode, "BRIDGE-HEAT", `ตรวจจับความร้อน ${BRIDGE_LABEL_TH} (ฝั่งอาคาร 3)`);
  return sensors;
}

let cached: MapRegistry | null = null;

export function getMapRegistry(): MapRegistry {
  if (cached) return cached;
  const graph = createEvacuationGraph();
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeMap = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const buildingOf = new Map<string, string>();
  const zoneOf = new Map<string, string | null>();
  for (const node of graph.nodes) {
    buildingOf.set(node.id, nodeBuilding(node));
    zoneOf.set(node.id, reportZoneOf(node));
  }
  // Checkpoint codes are short and typeable: building + floor + running number (stable per map version).
  const groups = new Map<string, SimNode[]>();
  for (const node of graph.nodes) {
    if (!CHECKPOINT_TYPES.has(node.type)) continue;
    const key = `${buildingCode(buildingOf.get(node.id) ?? "site")}-${node.floor}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(node);
  }
  const checkpoints: CheckpointEntry[] = [];
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([key, nodes]) => {
    [...nodes].sort((a, b) => a.id.localeCompare(b.id)).forEach((node, index) => {
      const [code, floor] = key.split("-");
      checkpoints.push({
        id: `${code}${code === "OUT" ? "" : `F${floor}`}-${String(index + 1).padStart(3, "0")}`,
        nodeId: node.id,
        buildingId: buildingOf.get(node.id) ?? "site",
        floor: node.floor,
        zoneId: zoneOf.get(node.id) ?? null,
        name: displayNodeName(node),
        kind: node.type,
      });
    });
  });
  const zoneLabels = new Map<string, string>();
  for (const zone of new Set(zoneOf.values())) if (zone) zoneLabels.set(zone, zoneLabel(zone));
  // The school's planned room allocation for a full 3,000-person day (same as the simulator).
  const plannedByRoom = new Map<string, number>();
  for (const { room, count } of activeRoomPopulation(3000)) if (nodeMap.has(room.id)) plannedByRoom.set(room.id, count);
  cached = {
    mapVersion: computeMapVersion(graph),
    graph, nodeMap, edgeMap, buildingOf, zoneOf,
    checkpoints,
    checkpointById: new Map(checkpoints.map((entry) => [entry.id, entry])),
    checkpointByNode: new Map(checkpoints.map((entry) => [entry.nodeId, entry])),
    sensors: buildSensors(graph, buildingOf, zoneOf),
    assemblies: graph.nodes.filter((node) => node.type === "assembly"),
    zoneLabels,
    plannedByRoom,
  };
  return cached;
}

export function buildMapPackage(registry = getMapRegistry()): MapPackage {
  const buildings = new Map<string, Set<number>>();
  for (const node of registry.graph.nodes) {
    const building = registry.buildingOf.get(node.id) ?? "site";
    (buildings.get(building) ?? buildings.set(building, new Set()).get(building)!).add(node.floor);
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    mapVersion: registry.mapVersion,
    generatedAt: new Date().toISOString(),
    buildings: ["building-1", "building-3", "building-4", "site"].filter((id) => buildings.has(id)).map((id) => ({
      id, name: BUILDING_NAMES[id] ?? id, floors: [...buildings.get(id)!].sort((a, b) => a - b),
    })),
    nodes: registry.graph.nodes.map((node) => ({
      id: node.id, name: displayNodeName(node), type: node.type, buildingId: registry.buildingOf.get(node.id) ?? "site",
      floor: node.floor, x: round(node.position[0]), z: round(node.position[2]), zoneId: registry.zoneOf.get(node.id) ?? null,
    })),
    edges: registry.graph.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, twoWay: edge.twoWay, floorFrom: edge.floorFrom, floorTo: edge.floorTo })),
    checkpoints: registry.checkpoints.map((entry) => ({ ...entry })),
    assemblies: registry.assemblies.map((node) => ({ id: node.id, name: displayNodeName(node), capacity: node.capacity })),
    offlineNote: "แผนผังนี้เป็นแผนอพยพคงที่ตามแบบจำลองของโรงเรียน ใช้อ้างอิงเท่านั้น ไม่ใช่คำแนะนำสดขณะเกิดเหตุ — ทำตามคำสั่งครูและเจ้าหน้าที่",
  };
}

export interface PassageGroup { id: string; label: string; edgeIds: string[] }

/** Closable passages — the same groups (and ids) the 3D simulator offers under "ทางที่ถูกปิด". */
export function passageGroups(registry = getMapRegistry()): PassageGroup[] {
  const edges = registry.graph.edges;
  const groups: PassageGroup[] = [];
  for (const zone of ["left", "center", "right"] as const) {
    const label = zone === "left" ? "ซ้าย" : zone === "center" ? "กลาง" : "ขวา";
    groups.push({ id: `b1-stair-${zone}`, label: `บันได${label} อาคาร 1`, edgeIds: edges.filter((edge) => edge.id.startsWith(`edge-stair-${zone}-`)).map((edge) => edge.id) });
    groups.push({ id: `b1-exit-${zone}`, label: `ทางออก${label} อาคาร 1`, edgeIds: edges.filter((edge) => edge.id === `edge-${zone}-door-exit`).map((edge) => edge.id) });
  }
  for (const building of [3, 4]) for (const stair of [0, 1]) {
    groups.push({ id: `b${building}-stair-${stair}`, label: `บันได ${stair + 1} อาคาร ${building}`, edgeIds: edges.filter((edge) => edge.id.startsWith(`campus-b${building}-stair-${stair}-down-`)).map((edge) => edge.id) });
    groups.push({ id: `b${building}-exit-${stair}`, label: `ทางออก ${stair + 1} อาคาร ${building}`, edgeIds: edges.filter((edge) => edge.id === `campus-b${building}-exit-door-${stair}`).map((edge) => edge.id) });
  }
  groups.push({ id: "b34-bridge", label: BRIDGE_LABEL_TH, edgeIds: edges.filter((edge) => edge.id === BRIDGE_EDGE_ID).map((edge) => edge.id) });
  return groups.filter((group) => group.edgeIds.length);
}

/** Human label for a closed or busy passage. */
export function passageLabel(edgeId: string, registry = getMapRegistry()): string {
  const group = passageGroups(registry).find((candidate) => candidate.edgeIds.includes(edgeId));
  if (group) return group.label;
  const edge = registry.edgeMap.get(edgeId);
  if (!edge) return edgeId;
  const from = registry.nodeMap.get(edge.from), to = registry.nodeMap.get(edge.to);
  if (edge.kind === "stair") return stairBaseName(to ?? from);
  return `${displayNodeName(from)} → ${displayNodeName(to)}`;
}
