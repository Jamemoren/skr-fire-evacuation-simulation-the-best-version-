/**
 * Spawn choice for the roleplay simulator: building → floor → room or checkpoint, validated against
 * the same walkable geometry, fire model and crowd the simulation uses. An invalid point is never
 * moved silently: the reasons are returned with a valid alternative on the same building and floor,
 * which the user sees (marker) before confirming.
 */
import { pointRisk } from "../simulation/graph";
import { ALL_CLASSROOMS } from "../simulation/campusData";
import { getMapRegistry, displayNodeName } from "../evac/mapRegistry";
import type { FireSource, Vec3 } from "../simulation/types";
import { supportsAt, walkWorld, type WalkWorld } from "./playerMotion";

export interface SpawnChoice {
  buildingId: string;
  floor: number;
  /** Classroom id, or a checkpoint id (QR checkpoint of the guidance map). */
  kind: "room" | "checkpoint";
  id: string;
}

export interface SpawnCheck {
  ok: boolean;
  point: Vec3 | null;
  reasons: string[];
  label: string;
}

export interface SpawnPlan {
  requested: SpawnCheck;
  /** Same building and floor; null when nothing valid exists there. */
  suggestion: (SpawnCheck & { choice: SpawnChoice }) | null;
}

export const BUILDING_LABEL: Record<string, string> = { "building-1": "อาคาร 1", "building-3": "อาคาร 3", "building-4": "อาคาร 4" };

/** Floors with classrooms or checkpoints, per building. */
export function spawnFloors(buildingId: string): number[] {
  const registry = getMapRegistry();
  const floors = new Set<number>();
  ALL_CLASSROOMS.forEach((room) => { if ((room.buildingId ?? "building-1") === buildingId) floors.add(room.floor); });
  registry.checkpoints.forEach((checkpoint) => { if (checkpoint.buildingId === buildingId && checkpoint.floor > 0) floors.add(checkpoint.floor); });
  return [...floors].sort((a, b) => a - b);
}

/** Rooms and (non-stair) checkpoints of one floor, rooms first. */
export function spawnOptions(buildingId: string, floor: number): Array<{ kind: "room" | "checkpoint"; id: string; label: string }> {
  const registry = getMapRegistry();
  const rooms = ALL_CLASSROOMS.filter((room) => (room.buildingId ?? "building-1") === buildingId && room.floor === floor)
    .map((room) => ({ kind: "room" as const, id: room.id, label: room.name }));
  const checkpoints = registry.checkpoints
    .filter((checkpoint) => checkpoint.buildingId === buildingId && checkpoint.floor === floor && checkpoint.kind !== "room" && checkpoint.kind !== "stair")
    .map((checkpoint) => ({ kind: "checkpoint" as const, id: checkpoint.id, label: `${checkpoint.name} · ${checkpoint.id}` }));
  return [...rooms, ...checkpoints];
}

function candidatePoints(choice: SpawnChoice, world: WalkWorld): { points: Vec3[]; label: string } {
  if (choice.kind === "room") {
    const box = world.roomsByNode.get(choice.id);
    if (!box) return { points: [], label: choice.id };
    // A grid over the classroom, nearest the door side first (a person gets up and heads out).
    const points: Vec3[] = [];
    for (let x = box.minX + 0.3; x <= box.maxX - 0.3; x += 0.55) for (let z = box.minZ + 0.3; z <= box.maxZ - 0.3; z += 0.55) points.push([x, box.y, z]);
    const node = world.nodeMap.get(choice.id);
    const door = [...(world.neighbours.get(`room:${choice.id}`) ?? [])].find((support) => support.kind === "edge");
    const doorPoint = door && door.kind === "edge" ? (door.edge.from === choice.id ? door.path[door.path.length - 1] : door.path[0]) : node?.position;
    if (doorPoint) points.sort((a, b) => Math.hypot(a[0] - doorPoint[0], a[2] - doorPoint[2]) - Math.hypot(b[0] - doorPoint[0], b[2] - doorPoint[2]));
    return { points, label: box.name };
  }
  const registry = getMapRegistry();
  const checkpoint = registry.checkpointById.get(choice.id);
  const node = checkpoint ? world.nodeMap.get(checkpoint.nodeId) : undefined;
  return { points: node ? [[...node.position] as Vec3] : [], label: checkpoint ? checkpoint.name : choice.id };
}

/**
 * Check one point. `npcs` are the simulated people's start positions; `fires` the scenario's fires
 * (checked now and 10 s ahead, so nobody is placed where flames arrive at once).
 */
export function checkSpawnPoint(point: Vec3, choice: SpawnChoice, fires: FireSource[], npcs: Vec3[], world: WalkWorld = walkWorld()): string[] {
  const reasons: string[] = [];
  const registry = getMapRegistry();
  const found = supportsAt(world, point, 0.3);
  if (!found.length) {
    reasons.push("จุดนี้ไม่อยู่บนพื้นที่เดินได้ (อยู่ในกำแพง ช่องบันได ช่องลิฟต์ หรือนอกทางเดิน)");
    return reasons;
  }
  const { support, y } = found[0];
  if (Math.abs(y - point[1]) > 0.05) reasons.push("ความสูงไม่ตรงกับพื้นของชั้นนี้");
  const buildingId = support.kind === "room" ? support.room.buildingId : registry.buildingOf.get(support.edge.from) ?? "site";
  const floor = support.kind === "room" ? support.room.floor : world.nodeMap.get(support.edge.from)?.floor ?? 0;
  if (support.kind === "edge" && support.edge.kind === "stair") reasons.push("จุดเกิดอยู่บนบันได — เลือกชานพักหรือทางเดินแทน");
  if (buildingId !== choice.buildingId) reasons.push(`จุดนี้อยู่ใน${BUILDING_LABEL[buildingId] ?? "พื้นที่ภายนอก"} ไม่ใช่${BUILDING_LABEL[choice.buildingId] ?? choice.buildingId}`);
  if (floor !== choice.floor) reasons.push(`จุดนี้อยู่ชั้น ${floor} ไม่ใช่ชั้น ${choice.floor}`);
  for (const offset of [0, 10]) {
    const risk = pointRisk(point, fires, offset, 0.3);
    if (risk.blocked || risk.fire > 0.03) { reasons.push(offset === 0 ? "จุดนี้อยู่ในเปลวไฟ" : "เปลวไฟจะลามถึงจุดนี้ภายใน 10 วินาที"); break; }
  }
  const nearest = npcs.reduce((best, other) => Math.abs(other[1] - point[1]) < 1.2 ? Math.min(best, Math.hypot(other[0] - point[0], other[2] - point[2])) : best, Infinity);
  if (nearest < 0.5) reasons.push("ซ้อนกับตำแหน่งของคนในแบบจำลอง");
  return reasons;
}

function firstValid(choice: SpawnChoice, fires: FireSource[], npcs: Vec3[], world: WalkWorld): SpawnCheck {
  const { points, label } = candidatePoints(choice, world);
  if (!points.length) return { ok: false, point: null, reasons: ["ไม่พบจุดนี้ในแผนที่รุ่นปัจจุบัน"], label };
  let firstReasons: string[] | null = null;
  for (const point of points) {
    const reasons = checkSpawnPoint(point, choice, fires, npcs, world);
    if (!reasons.length) return { ok: true, point, reasons: [], label };
    firstReasons ??= reasons;
  }
  return { ok: false, point: points[0], reasons: firstReasons ?? [], label };
}

/** Validate the requested spawn and, if it fails, find a valid one on the same building and floor. */
export function planSpawn(choice: SpawnChoice, fires: FireSource[], npcs: Vec3[], world: WalkWorld = walkWorld()): SpawnPlan {
  const requested = firstValid(choice, fires, npcs, world);
  if (requested.ok) return { requested, suggestion: null };
  const options = spawnOptions(choice.buildingId, choice.floor).filter((option) => option.id !== choice.id);
  const target = requested.point;
  const scored = options.map((option) => {
    const { points } = candidatePoints({ ...choice, kind: option.kind, id: option.id }, world);
    const p = points[0];
    return { option, distance: p && target ? Math.hypot(p[0] - target[0], p[2] - target[2]) : Infinity };
  }).sort((a, b) => a.distance - b.distance);
  for (const { option } of scored) {
    const alternative: SpawnChoice = { ...choice, kind: option.kind, id: option.id };
    const check = firstValid(alternative, fires, npcs, world);
    if (check.ok) return { requested, suggestion: { ...check, choice: alternative } };
  }
  return { requested, suggestion: null };
}

export function spawnLabel(choice: SpawnChoice): string {
  const registry = getMapRegistry();
  if (choice.kind === "room") return ALL_CLASSROOMS.find((room) => room.id === choice.id)?.name ?? choice.id;
  const checkpoint = registry.checkpointById.get(choice.id);
  return checkpoint ? displayNodeName(registry.nodeMap.get(checkpoint.nodeId)) : choice.id;
}
