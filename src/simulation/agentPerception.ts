/**
 * Approximate, explainable line-of-sight and communication zones for occupants.
 *
 * The model deliberately avoids per-ray geometry tests for 3,000 people. Instead every graph node
 * belongs to a *visual space* (one classroom, one corridor wing of one floor of one building, one
 * stair landing, or the open site). A person can see a hazard only inside the same space or in
 * an adjacent space through a real opening (classroom door ↔ corridor, wing ↔ central junction,
 * corridor ↔ stair landing, B3 ↔ B4 across the fourth-floor bridge), and only within the sight
 * distance. Walls and floor slabs therefore block sight; a fire in the next classroom is not
 * "seen" through the dividing wall. Smoke/heat cues still reach people through pointRisk() falloff,
 * but only inside the same building and floor.
 */
import type { SimEdge, SimGraph, SimNode } from "./types";

export type BuildingId = "building-1" | "building-3" | "building-4" | "site";

export interface VisualSpace {
  key: string;
  kind: "room" | "corridor" | "stair" | "outdoor";
  building: BuildingId;
  floor: number;
  wing: string;
}

export interface PerceptionTopology {
  space: Map<string, VisualSpace>;
  /** Adjacent spaces through a physical opening. Always symmetric. */
  adjacent: Map<string, Set<string>>;
  /** Room node id → door node id (and back) so doors belong to both sides. */
  doorOfRoom: Map<string, string>;
  roomOfDoor: Map<string, string>;
}

export function nodeBuilding(node: SimNode | undefined): BuildingId {
  if (!node) return "site";
  if (node.wing === "building-3" || node.id.includes("-b3-") || node.id.startsWith("b3-")) return node.floor === 0 ? "site" : "building-3";
  if (node.wing === "building-4" || node.id.includes("-b4-") || node.id.startsWith("b4-")) return node.floor === 0 ? "site" : "building-4";
  if (node.floor === 0 || node.type === "gate" || node.type === "assembly") return "site";
  return "building-1";
}

function spaceFor(node: SimNode, roomOfDoor: Map<string, string>): VisualSpace {
  const building = nodeBuilding(node);
  if (building === "site" || node.type === "exit" || node.type === "gate" || node.type === "assembly") {
    return { key: "site", kind: "outdoor", building: "site", floor: 0, wing: "outdoor" };
  }
  if (node.type === "room") return { key: `room:${node.id}`, kind: "room", building, floor: node.floor, wing: node.wing };
  if (node.type === "stair") {
    const zone = node.id.replace(/-f\d+$/, "");
    return { key: `stair:${zone}:${node.floor}`, kind: "stair", building, floor: node.floor, wing: node.wing };
  }
  if (node.type === "door" && roomOfDoor.has(node.id)) {
    // A classroom door is visually part of the corridor; the room side is handled as adjacency.
    return { key: `corr:${building}:${node.floor}:${node.wing}`, kind: "corridor", building, floor: node.floor, wing: node.wing };
  }
  return { key: `corr:${building}:${node.floor}:${node.wing}`, kind: "corridor", building, floor: node.floor, wing: node.wing };
}

function link(adjacent: Map<string, Set<string>>, a: string, b: string) {
  if (a === b) return;
  (adjacent.get(a) ?? adjacent.set(a, new Set()).get(a)!).add(b);
  (adjacent.get(b) ?? adjacent.set(b, new Set()).get(b)!).add(a);
}

const topologyCache = new WeakMap<SimGraph, PerceptionTopology>();

export function perceptionTopology(graph: SimGraph): PerceptionTopology {
  const cached = topologyCache.get(graph);
  if (cached) return cached;
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const doorOfRoom = new Map<string, string>();
  const roomOfDoor = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "room") continue;
    const a = nodeMap.get(edge.from);
    const b = nodeMap.get(edge.to);
    if (a?.type === "room" && b?.type === "door") { doorOfRoom.set(a.id, b.id); roomOfDoor.set(b.id, a.id); }
    else if (b?.type === "room" && a?.type === "door") { doorOfRoom.set(b.id, a.id); roomOfDoor.set(a.id, b.id); }
  }
  const space = new Map<string, VisualSpace>();
  graph.nodes.forEach((node) => space.set(node.id, spaceFor(node, roomOfDoor)));
  const adjacent = new Map<string, Set<string>>();
  // Room ↔ corridor only through that room's own door.
  roomOfDoor.forEach((roomId, doorId) => link(adjacent, space.get(roomId)!.key, space.get(doorId)!.key));
  // Any horizontal walkable edge that joins two different spaces is an opening between them
  // (wing ↔ junction, corridor ↔ stair landing, B3 ↔ B4 bridge, ground-floor exit ↔ site).
  const walkableKinds = new Set<SimEdge["kind"]>(["corridor", "junction", "exit", "outdoor"]);
  for (const edge of graph.edges) {
    if (!walkableKinds.has(edge.kind)) continue;
    const a = space.get(edge.from);
    const b = space.get(edge.to);
    if (!a || !b || a.key === b.key) continue;
    if (a.kind === "room" || b.kind === "room") continue;
    link(adjacent, a.key, b.key);
  }
  const topology = { space, adjacent, doorOfRoom, roomOfDoor };
  topologyCache.set(graph, topology);
  return topology;
}

/** True when two spaces are the same or share a physical opening. */
export function spacesInView(topology: PerceptionTopology, a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return topology.adjacent.get(a)?.has(b) ?? false;
}

/**
 * Report zones: shouted warnings travel within one building wing/floor first, then to the other
 * wings of that floor and to the floors directly above/below through the same building. They never
 * jump to another building except across the B3–B4 fourth-floor bridge.
 */
export function reportZoneOf(node: SimNode | undefined): string | null {
  if (!node) return null;
  const building = nodeBuilding(node);
  if (building === "site") return null;
  return `${building}:${node.floor}:${node.wing}`;
}

export function neighbouringReportZones(zone: string): Array<{ zone: string; delay: number }> {
  const [building, floorText, wing] = zone.split(":");
  const floor = Number(floorText);
  const result: Array<{ zone: string; delay: number }> = [];
  if (building === "building-1") {
    for (const other of ["pink", "blue", "core"]) if (other !== wing) result.push({ zone: `${building}:${floor}:${other}`, delay: 1.6 });
    for (const offset of [-1, 1]) {
      const next = floor + offset;
      if (next >= 1 && next <= 9) result.push({ zone: `${building}:${next}:${wing}`, delay: 2.6 });
    }
  } else {
    for (const offset of [-1, 1]) {
      const next = floor + offset;
      if (next >= 1 && next <= 4) result.push({ zone: `${building}:${next}:${wing}`, delay: 2.6 });
    }
    if (floor === 4) {
      const other = building === "building-3" ? "building-4" : "building-3";
      result.push({ zone: `${other}:4:${other}`, delay: 3.2 });
    }
  }
  return result;
}
