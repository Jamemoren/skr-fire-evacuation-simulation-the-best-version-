/**
 * What the model editor changes in the simulation, and what it may not.
 *
 * The simulator walks the school's network (nodes, passages, stairs) against the physical model.
 * Editor changes are applied when a run starts, each only with evidence that people could really
 * walk it:
 *   - "จุดจำลองไฟ" markers  → fires at those points;
 *   - "พื้นที่ห้ามผ่าน" boxes → every passage through the box is closed;
 *   - a passage switched off or deleted, or a node deleted → those passages are closed
 *     (a deleted classroom has nobody in it; at least one assembly area must remain);
 *   - people per classroom → exactly those counts;
 *   - a passage made narrower / lower capacity / one-way → applied as edited
 *     (wider, higher capacity, or two-way where the standard is one-way: refused — walls are fixed);
 *   - a door / corridor / junction point moved, a passage re-bent, new points (door, corridor,
 *     junction, assembly area) and new passages → applied only when the drawn 3D model shows a floor
 *     under the whole path and no wall, railing, window or tree across it (modelPhysics), on the
 *     same level (changing floors only by the existing stairs);
 *   - names, notes, tags, visibility, locks, labels → kept, no effect on walking.
 * Everything else (moving or resizing classrooms, stairs, exits, assembly areas; changing an item's
 * type or a passage's ends; imported models; object edits; calibration) is listed item by item and
 * the run is not started on it.
 */
import { buildGeneratedSemanticMap } from "./semanticGraph";
import { createEvacuationGraph } from "./graph";
import { applyGraphEdits, edgePolyline, hasGraphEdits, type GraphEdits } from "./graphEdits";
import type { WalkPhysics } from "./modelPhysics";
import type { SemanticAnnotation, SemanticMapFile } from "../types";
import type { SimEdge, SimGraph, SimNode, SimNodeType, Vec3 } from "./types";

export interface EditorScenario {
  fires: Array<{ id: string; name: string; position: Vec3 }>;
  restricted: Array<{ id: string; name: string; edgeIds: string[] }>;
  /** Standard passages closed by the editor (switched off, deleted, or touching a deleted node). */
  disabledEdgeIds: string[];
  /** Null = unchanged from the standard spread. */
  roomPopulation: Record<string, number> | null;
  roomPopulationTotal: number;
  /** Network changes (moved points, narrowed/one-way/re-bent passages, new points and passages). */
  graphEdits: GraphEdits | null;
}

export interface EditorAnalysis {
  /** True when the simulator can run this map (possibly with scenario edits). */
  runnable: boolean;
  /** True when nothing at all differs from the standard map. */
  standard: boolean;
  /** Why it cannot run, one line per problem (with the item's name). */
  blockers: string[];
  /** What the run will apply from the editor, in plain Thai (shown to the user). */
  applied: string[];
  /** Notes that do not stop a run (no effect on walking, people without a way out, phone guidance). */
  notes: string[];
  /** Standard items whose saved shape differs from the model (fixed by alignToModel). */
  driftCount: number;
  scenario: EditorScenario;
}

const EMPTY: EditorScenario = { fires: [], restricted: [], disabledEdgeIds: [], roomPopulation: null, roomPopulationTotal: 0, graphEdits: null };
const SCENARIO_TYPES = new Set(["fire-source", "restricted-area"]);
/** Points that only steer the walking line; the room, stair, exit and assembly shapes are structure. */
const MOVABLE_TYPES = new Set<SimNodeType>(["door", "corridor", "junction", "gate"]);
const NEW_NODE_TYPES: Partial<Record<SemanticAnnotation["type"], SimNodeType>> = { door: "door", hallway: "corridor", "navigation-node": "junction", "assembly-area": "assembly" };
const TYPE_TH: Record<string, string> = { classroom: "ห้องเรียน", stair: "บันได", exit: "ทางออก", "assembly-area": "จุดรวมพล", building: "อาคาร", floor: "ชั้น", "football-field": "สนาม", custom: "จุดกำหนดเอง", door: "ประตู", hallway: "ทางเดิน", "navigation-node": "จุดนำทาง" };
/** Millimetre tolerance: saved maps from older code differ by float noise (e.g. -54.836 vs -54.836000000000006). */
const EPS = 1e-3;
const sameVec = (a: Vec3 | undefined, b: Vec3 | undefined) => !!a && !!b && a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) < EPS);
const samePoints = (a: Vec3[] = [], b: Vec3[] = []) => a.length === b.length && a.every((p, i) => sameVec(p, b[i]));
const sameNumber = (a: number, b: number) => Math.abs(a - b) < EPS;
/** Passage ids from earlier versions of the standard map and the passage they are now. */
const LEGACY_EDGE_IDS: Record<string, string> = { "campus-straight-bridge-level-4": "campus-straight-bridge-level-3" };
const fmt = (p: Vec3) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`;

let template: SemanticMapFile | null = null;
let graphCache: { graph: SimGraph; nodes: Map<string, SimNode>; edges: SimEdge[] } | null = null;
const standardMap = () => (template ??= buildGeneratedSemanticMap());
const standardGraph = () => {
  if (!graphCache) { const graph = createEvacuationGraph(); graphCache = { graph, nodes: new Map(graph.nodes.map((node) => [node.id, node])), edges: graph.edges }; }
  return graphCache;
};

/** Passages whose walked line enters the box (rotation about Y respected). */
export function edgesThroughBox(area: Pick<SemanticAnnotation, "position" | "rotation" | "size">, graph?: { nodes: Map<string, SimNode>; edges: SimEdge[] }): string[] {
  const { nodes, edges } = graph ?? standardGraph();
  const [cx, cy, cz] = area.position;
  const [sx, sy, sz] = area.size.map((value) => Math.max(0.2, Math.abs(value))) as Vec3;
  const yaw = area.rotation?.[1] ?? 0, cos = Math.cos(-yaw), sin = Math.sin(-yaw);
  const inside = (p: Vec3) => {
    const dx = p[0] - cx, dz = p[2] - cz;
    const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
    return Math.abs(lx) <= sx / 2 && Math.abs(lz) <= sz / 2 && Math.abs(p[1] - cy) <= sy / 2 + 0.3;
  };
  const hit: string[] = [];
  for (const edge of edges) {
    const points = edgePolyline(edge, nodes);
    let found = false;
    for (let i = 1; i < points.length && !found; i += 1) {
      const p = points[i - 1], q = points[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / 0.5));
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        if (inside([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t])) { found = true; break; }
      }
    }
    if (found) hit.push(edge.id);
  }
  return hit;
}

function obstacleName(name: string): string {
  const n = name.toUpperCase();
  const kind = n.includes("TREE") ? "ต้นไม้" : n.includes("RAIL") || n.includes("BALUSTER") ? "ราวกันตก" : n.includes("WINDOW") || n.includes("GLASS") ? "หน้าต่าง/กระจก"
    : n.includes("COLUMN") || n.includes("POST") || n.includes("PILLAR") ? "เสา" : n.includes("STAIR") ? "บันได" : n.includes("WALL") || n.includes("PARTITION") || n.includes("PLASTER") || n.includes("FACADE") ? "ผนัง" : "วัตถุในโมเดล";
  return `${kind} (${name})`;
}

/**
 * Can a person walk this line? Floor under it every 0.5 m, nothing at knee or head height along the
 * walking line, and no change of level (stairs only). The same evidence every standard passage
 * meets (all 570 non-stair standard passages pass it on the drawn model).
 * Returns the reason in Thai, or null when the line is walkable.
 */
export function walkProblem(points: Vec3[], physics: WalkPhysics): string | null {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i];
    if (Math.abs(a[1] - b[1]) > 0.6) return `ต่างระดับ ${Math.abs(a[1] - b[1]).toFixed(1)} ม. — ขึ้นลงชั้นได้เฉพาะบันไดที่มีในโมเดล`;
    const dx = b[0] - a[0], dz = b[2] - a[2], flat = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(flat / 0.5));
    for (let s = 0; s <= steps; s += 1) {
      const p: Vec3 = [a[0] + dx * s / steps, a[1] + (b[1] - a[1]) * s / steps, a[2] + dz * s / steps];
      if (physics.floorBelow(p) === null) return `ไม่มีพื้นรองรับที่ ${fmt(p)}`;
    }
    for (const height of [0.8, 1.65]) {
      const hit = physics.obstacle([a[0], a[1] + height, a[2]], [b[0], b[1] + height, b[2]]);
      if (hit) return `ชน${obstacleName(hit.name)} ที่ ${fmt(hit.point)}`;
    }
  }
  return null;
}

function nodeShapeChanged(a: SemanticAnnotation, b: SemanticAnnotation) {
  return !sameVec(a.rotation, b.rotation) || !sameVec(a.size, b.size);
}

/** Simulator height and identity for a point placed in the editor (standing on the floor under it). */
function placeOnFloor(position: Vec3, physics: WalkPhysics, graph: { nodes: Map<string, SimNode> }) {
  const floorY = physics.floorBelow([position[0], position[1] + 0.3, position[2]], 3);
  if (floorY === null) return null;
  const near = [...graph.nodes.values()]
    .filter((node) => node.type !== "stair" && node.type !== "room")
    .map((node) => ({ node, d: Math.hypot(node.position[0] - position[0], (node.position[1] - floorY) * 3, node.position[2] - position[2]) }))
    .sort((a, b) => a.d - b.d).slice(0, 8);
  for (const { node } of near) {
    const nodeFloor = physics.floorBelow(node.position);
    if (nodeFloor === null || Math.abs(nodeFloor - floorY) > 0.3) continue;
    return { position: [position[0], floorY + (node.position[1] - nodeFloor), position[2]] as Vec3, like: node };
  }
  return { position: [position[0], floorY + 0.2, position[2]] as Vec3, like: near[0]?.node ?? null };
}

/**
 * `physics` is the drawn model's collision check (modelPhysics), or a function returning it: it is
 * only asked for when the map has moved points or new/re-bent passages.
 */
export function analyzeEditorMap(map: Pick<SemanticMapFile, "annotations" | "connections" | "calibration" | "objects" | "model">, physics: WalkPhysics | (() => WalkPhysics | null) | null = null): EditorAnalysis {
  let resolved: WalkPhysics | null | undefined;
  const phys = () => (resolved !== undefined ? resolved : (resolved = typeof physics === "function" ? physics() : physics));
  const blockers: string[] = [];
  const notes: string[] = [];
  if (map.model.source !== "generated") blockers.push("ใช้โมเดลที่นำเข้าเอง — ระบบจำลองใช้ได้กับผังมาตรฐานอาคาร 1, 3, 4 เท่านั้น (หน้าแก้ไข › แท็บโมเดล › “ใช้ผังมาตรฐานอาคาร 1, 3, 4”)");
  if (Object.keys(map.objects ?? {}).length > 0) blockers.push("มีการแก้ไขวัตถุในโมเดล (ย้าย/ลบ/เพิ่มกล่อง) — ใช้ Undo หรือคืนค่าวัตถุที่แก้");
  if (map.calibration.scale !== 1 || [...map.calibration.position, ...map.calibration.rotation].some((v) => v !== 0)) blockers.push("Calibration ไม่ใช่ค่าเริ่มต้น — ตั้งตำแหน่ง/หมุนเป็น 0 และสเกลเป็น 1");

  const standard = standardMap();
  const graph = standardGraph();
  const nodes = new Map(map.annotations.map((node) => [node.id, node]));
  // A passage saved under an earlier id (e.g. the bridge when it was on floor 4) is that passage now.
  const edges = new Map(map.connections.map((edge) => [LEGACY_EDGE_IDS[edge.id] && !map.connections.some((other) => other.id === LEGACY_EDGE_IDS[edge.id]) ? LEGACY_EDGE_IDS[edge.id] : edge.id, edge]));
  const legacyIds = new Set(map.connections.filter((edge) => edges.get(LEGACY_EDGE_IDS[edge.id] ?? "") === edge).map((edge) => edge.id));
  const templateNodes = new Map(standard.annotations.map((node) => [node.id, node]));
  const templateEdges = new Map(standard.connections.map((edge) => [edge.id, edge]));
  const scenario: EditorScenario = { fires: [], restricted: [], disabledEdgeIds: [], roomPopulation: null, roomPopulationTotal: 0, graphEdits: null };
  const edits: GraphEdits = { nodePositions: {}, nodeCapacities: {}, edgeOverrides: {}, addedNodes: [], addedEdges: [] };
  const deletedAssembly = new Set<string>();
  const closed = new Set<string>();
  const deletedNodes: string[] = [], deletedEdges: string[] = [], visualOnly: string[] = [];
  const narrowed: string[] = [], oneWay: string[] = [], movedNames: string[] = [], rebent: string[] = [];
  const needsPhysics: Array<{ label: string; check: () => string | null }> = [];
  const failed = new Set<string>();
  const movedEdgeLabels = new Map<string, string[]>();
  /** Standard structure whose saved shape differs from the model: the run uses the model (noted, alignable). */
  const drift: string[] = [];
  let peopleChanged = false;
  const roomCounts: Record<string, number> = {};

  // ---- standard nodes
  for (const base of standard.annotations) {
    const simNode = graph.nodes.get(base.id);
    const node = nodes.get(base.id);
    if (!node) {
      if (!simNode) { visualOnly.push(`ลบ ${base.name}`); continue; } // context shapes: no effect on walking
      deletedNodes.push(base.name);
      if (simNode.type === "assembly") deletedAssembly.add(base.id);
      for (const edge of graph.edges) if (edge.from === base.id || edge.to === base.id) closed.add(edge.id);
      if (base.type === "classroom") { roomCounts[base.id] = 0; peopleChanged = true; }
      continue;
    }
    if (base.type === "classroom") {
      roomCounts[base.id] = Math.max(0, Math.round(node.peopleCount));
      if (Math.round(node.peopleCount) !== Math.round(base.peopleCount)) peopleChanged = true;
    }
    const label = node.name || base.name;
    // The type, floor and shape of a standard item come from the model: a different saved value
    // (older map version, or an edit) cannot change the building — the run uses the model.
    if (node.type !== base.type || node.shape !== base.shape || node.floor !== base.floor) { drift.push(label); continue; }
    if (!sameNumber(node.capacity, base.capacity)) {
      if (simNode?.type === "assembly" && node.capacity >= 1 && node.capacity < base.capacity) edits.nodeCapacities[base.id] = Math.round(node.capacity);
      else drift.push(label);
    }
    const moved = !sameVec(node.position, base.position);
    if (!moved && !nodeShapeChanged(node, base)) continue;
    if (!simNode) { visualOnly.push(label); continue; }
    if (!MOVABLE_TYPES.has(simNode.type)) {
      // Classrooms, stairs, exits and assembly areas are built structure: moving the marker does
      // not move them. Noted (with one-click alignment), never silently walked somewhere else.
      if (!drift.includes(label)) drift.push(label);
      continue;
    }
    if (!moved) { visualOnly.push(label); continue; }
    if (graph.edges.some((edge) => edge.kind === "stair" && (edge.from === base.id || edge.to === base.id))) {
      blockers.push(`ย้าย “${label}” — จุดนี้ต่อกับบันได ซึ่งย้ายตามไม่ได้ (ใช้ Undo)`);
      continue;
    }
    const delta = [0, 1, 2].map((i) => node.position[i] - base.position[i]);
    const next = simNode.position.map((v, i) => v + delta[i]) as Vec3;
    if (Math.abs(delta[1]) > 0.6) { blockers.push(`ย้าย “${label}” ขึ้น/ลง ${delta[1].toFixed(1)} ม. — ย้ายได้เฉพาะบนพื้นชั้นเดิม`); continue; }
    edits.nodePositions[base.id] = next;
    movedNames.push(label);
  }

  // ---- new points
  const newNodeIds = new Set<string>();
  const pendingNewNodes: SemanticAnnotation[] = [];
  for (const node of map.annotations) {
    if (templateNodes.has(node.id)) continue;
    if (node.type === "fire-source") { scenario.fires.push({ id: node.id, name: node.name || "จุดไฟ", position: [...node.position] as Vec3 }); continue; }
    if (node.type === "restricted-area") { scenario.restricted.push({ id: node.id, name: node.name || "พื้นที่ห้ามผ่าน", edgeIds: [] }); continue; }
    pendingNewNodes.push(node);
  }
  const connectedIds = new Set(map.connections.filter((edge) => !templateEdges.has(edge.id)).flatMap((edge) => [edge.fromId, edge.toId]));
  for (const node of pendingNewNodes) {
    const label = node.name || TYPE_TH[node.type] || "จุดใหม่";
    if (!connectedIds.has(node.id)) { visualOnly.push(label); continue; }
    const type = NEW_NODE_TYPES[node.type];
    if (!type) { blockers.push(`เพิ่ม${TYPE_TH[node.type] ?? "จุด"}ใหม่ “${label}” แล้วต่อเส้นทาง — ห้องเรียน บันได และทางออก ต้องมีอยู่จริงในโมเดล (เพิ่มได้: ประตู ทางเดิน จุดนำทาง จุดรวมพล)`); continue; }
    const P = phys();
    if (!P) { needsPhysics.push({ label, check: () => null }); continue; }
    const placed = placeOnFloor(node.position, P, graph);
    if (!placed) { blockers.push(`จุดใหม่ “${label}” ไม่อยู่บนพื้นในโมเดล ${fmt(node.position)}`); continue; }
    const like = placed.like;
    if (type === "assembly" && (!like || (like.phase !== "outdoor" && like.phase !== "assembly"))) { blockers.push(`จุดรวมพลใหม่ “${label}” ต้องอยู่ที่โล่งนอกอาคาร`); continue; }
    if (type === "assembly" && !(node.capacity >= 1)) { blockers.push(`จุดรวมพลใหม่ “${label}” ยังไม่ได้กำหนดความจุ (คน)`); continue; }
    edits.addedNodes.push({
      id: node.id, name: label, type, position: placed.position,
      floor: like?.floor ?? 1, capacity: type === "assembly" ? Math.round(node.capacity) : Math.max(4, Math.round(node.capacity || 20)),
      wing: type === "assembly" ? "assembly" : like?.wing ?? "outdoor", phase: type === "assembly" ? "assembly" : like?.phase ?? "outdoor",
    });
    newNodeIds.add(node.id);
  }

  // Simulator positions of every node after moves and additions.
  const positions = new Map<string, SimNode>(graph.nodes);
  for (const [id, position] of Object.entries(edits.nodePositions)) positions.set(id, { ...graph.nodes.get(id)!, position });
  for (const node of edits.addedNodes) positions.set(node.id, node);

  // ---- standard passages
  for (const base of standard.connections) {
    const simEdge = graph.edges.find((edge) => edge.id === base.id);
    const edge = edges.get(base.id);
    if (!edge) { deletedEdges.push(base.id); closed.add(base.id); continue; }
    const legacy = legacyIds.has(edge.id);
    if (edge.enabled === false && base.enabled !== false) closed.add(base.id);
    if (!simEdge) continue;
    if (legacy) { drift.push(`เส้นทาง ${edge.id} (รุ่นเก่า → ${base.id})`); continue; }
    if (edge.fromId !== base.fromId || edge.toId !== base.toId) {
      blockers.push(`เปลี่ยนปลายทางของเส้นทาง ${base.id} — ให้ลบ (หรือปิด) เส้นเดิมแล้วเพิ่มเส้นใหม่แทน หรือกด “จัดให้ตรงโมเดลจริง”`);
      continue;
    }
    if (edge.type !== base.type) drift.push(`เส้นทาง ${base.id}`);
    const override: GraphEdits["edgeOverrides"][string] = {};
    if (!sameNumber(edge.width, base.width)) {
      if (edge.width > base.width + 1e-6) blockers.push(`เส้นทาง ${base.id} กว้างขึ้นเป็น ${edge.width} ม. — กว้างเกินช่องทางจริง (${base.width} ม.) ไม่ได้ เพราะผนังอยู่ที่เดิม`);
      else if (edge.width < 0.5) blockers.push(`เส้นทาง ${base.id} กว้าง ${edge.width} ม. — แคบกว่า 0.5 ม. คนเดินไม่ได้ ให้ใช้ “ปิดเส้นทาง” แทน`);
      else { override.width = edge.width; narrowed.push(base.id); }
    }
    if (!sameNumber(edge.capacityPerSecond, base.capacityPerSecond)) {
      if (edge.capacityPerSecond > base.capacityPerSecond + 1e-6) blockers.push(`เส้นทาง ${base.id} ความจุ ${edge.capacityPerSecond} คน/วินาที — เพิ่มเกินค่าจริง (${base.capacityPerSecond}) ไม่ได้`);
      else if (edge.capacityPerSecond <= 0) blockers.push(`เส้นทาง ${base.id} ความจุ 0 — ให้ใช้ “ปิดเส้นทาง” แทน`);
      else { override.capacityPerSecond = edge.capacityPerSecond; if (!narrowed.includes(base.id)) narrowed.push(base.id); }
    }
    if (override.width && !override.capacityPerSecond) override.capacityPerSecond = simEdge.capacityPerSecond * override.width / simEdge.width;
    if (edge.bidirectional !== base.bidirectional) {
      if (edge.bidirectional) blockers.push(`เส้นทาง ${base.id} เปลี่ยนเป็นสองทาง — เส้นนี้เดินได้ทางเดียวตามโครงสร้าง`);
      else { override.twoWay = false; oneWay.push(base.id); }
    }
    const bent = !samePoints(edge.waypoints ?? [], base.waypoints ?? []);
    const movedEnd = !!(edits.nodePositions[base.fromId] || edits.nodePositions[base.toId]);
    // A stair's line is the built stair: a different saved line is noted and the real stair is used.
    if (bent && simEdge.kind === "stair") { drift.push(`แนวบันได ${base.id}`); }
    else if (bent || movedEnd) {
      const from = positions.get(base.fromId)!, to = positions.get(base.toId)!;
      const waypoints = bent ? (edge.waypoints ?? []).map((p, i, all) => {
        const t = (i + 1) / (all.length + 1);
        return [p[0], from.position[1] + (to.position[1] - from.position[1]) * t, p[2]] as Vec3;
      }) : simEdge.waypoints ?? [];
      if (bent) { override.waypoints = waypoints; rebent.push(base.id); }
      const label = `เส้นทาง ${base.id}`;
      for (const end of [base.fromId, base.toId]) if (edits.nodePositions[end]) {
        const name = nodes.get(end)?.name || templateNodes.get(end)?.name || end;
        movedEdgeLabels.set(name, [...(movedEdgeLabels.get(name) ?? []), label]);
      }
      const points = [from.position, ...waypoints, to.position];
      needsPhysics.push({ label, check: () => walkProblem(points, phys()!) });
    }
    if (Object.keys(override).length) edits.edgeOverrides[base.id] = override;
  }

  // ---- new passages
  const added: string[] = [];
  for (const edge of map.connections) {
    if (templateEdges.has(edge.id) || legacyIds.has(edge.id)) continue;
    const label = `เส้นทางใหม่ ${edge.id}`;
    if (edge.enabled === false) { visualOnly.push(label); continue; }
    const fromNode = nodes.get(edge.fromId), toNode = nodes.get(edge.toId);
    if (!fromNode || !toNode) { blockers.push(`${label} ปลายทางหายไป — ลบเส้นนี้หรือเชื่อมใหม่`); continue; }
    const bad = [fromNode, toNode].find((node) => SCENARIO_TYPES.has(node.type));
    if (bad) { blockers.push(`${label} ต่อกับ “${bad.name}” ซึ่งเป็นเครื่องหมายสถานการณ์ ไม่ใช่ทางเดิน`); continue; }
    const from = positions.get(edge.fromId), to = positions.get(edge.toId);
    if (!from || !to) {
      if (phys()) blockers.push(`${label} ต่อกับจุดที่ระบบจำลองไม่ได้รับ (ดูรายการข้างบน)`);
      else needsPhysics.push({ label, check: () => null });
      continue;
    }
    if (edge.width < 0.8) { blockers.push(`${label} กว้าง ${edge.width} ม. — เส้นทางใหม่ต้องกว้างอย่างน้อย 0.8 ม.`); continue; }
    if (from.type === "stair" || to.type === "stair") { blockers.push(`${label} ต่อเข้าบันไดโดยตรง — ต่อกับทางเดินหน้าบันไดแทน`); continue; }
    const waypoints = (edge.waypoints ?? []).map((p, i, all) => {
      const t = (i + 1) / (all.length + 1);
      return [p[0], from.position[1] + (to.position[1] - from.position[1]) * t, p[2]] as Vec3;
    });
    // The router's level rules (graph.ts topologyAllowed): corridors on floors 2+, the ground floor
    // moves by "exit" passages, building → open ground by "outdoor", open ground by "assembly".
    const kind: SimEdge["kind"] | null = from.floor === 0 && to.floor === 0 ? "assembly"
      : from.floor === 1 && to.floor === 0 ? "outdoor"
      : from.floor === 1 && to.floor === 1 ? "exit"
      : from.floor === to.floor && from.floor >= 2 ? "corridor" : null;
    if (!kind) {
      blockers.push(from.floor !== to.floor
        ? `${label} ต่างระดับ (ชั้น ${from.floor} → ชั้น ${to.floor}) — ข้ามชั้นได้เฉพาะบันไดที่มีอยู่จริง · ทางใหม่ต่อได้ในชั้นเดียวกัน หรือจากชั้น 1 ออกสู่ที่โล่ง (ทิศเดียว)`
        : `${label} บนชั้น ${from.floor} — ทางใหม่ต่อได้ในชั้นเดียวกันตั้งแต่ชั้น 2 ขึ้นไป หรือบนชั้น 1 ระหว่างจุดในอาคาร`);
      continue;
    }
    // Flow through a doorway-sized gap is about 1.3 persons per metre per second.
    const capacity = Math.min(edge.capacityPerSecond > 0 ? edge.capacityPerSecond : edge.width * 1.3, edge.width * 1.5);
    if (edge.capacityPerSecond > edge.width * 1.5) notes.push(`${label}: ความจุลดเหลือ ${capacity.toFixed(1)} คน/วินาที ตามความกว้าง ${edge.width} ม.`);
    edits.addedEdges.push({ id: edge.id, from: edge.fromId, to: edge.toId, kind, width: edge.width, capacityPerSecond: capacity, speedMultiplier: 1, twoWay: kind === "outdoor" ? false : edge.bidirectional, waypoints, insideBuilding: kind === "corridor" || (kind === "exit" && from.phase !== "outdoor") });
    const points = [from.position, ...waypoints, to.position];
    needsPhysics.push({ label, check: () => walkProblem(points, phys()!) });
    added.push(edge.id);
  }

  // ---- physical evidence for every changed line
  if (needsPhysics.length && !phys()) {
    blockers.push(`มีจุด/เส้นทางที่ย้ายหรือเพิ่ม ${needsPhysics.length} รายการ — รอให้โมเดล 3 มิติโหลดครบในมุมมองภายนอก (ทุกชั้น เปิดผนัง ไม่แยกชั้น) เพื่อตรวจพื้นและผนังก่อน`);
  } else {
    for (const item of needsPhysics) { const problem = item.check(); if (problem) { blockers.push(`${item.label}: ${problem}`); failed.add(item.label); } }
  }

  // ---- restricted areas, on the network as edited
  const editedGraph = applyGraphEdits(graph.graph, edits);
  const editedNodes = new Map(editedGraph.nodes.map((node) => [node.id, node]));
  for (const area of scenario.restricted) {
    const box = nodes.get(area.id)!;
    area.edgeIds = edgesThroughBox(box, { nodes: editedNodes, edges: editedGraph.edges });
  }
  scenario.disabledEdgeIds = [...closed];
  if (!editedGraph.nodes.some((node) => node.type === "assembly" && !deletedAssembly.has(node.id))) blockers.push("ไม่เหลือจุดรวมพล — ต้องมีจุดรวมพลอย่างน้อย 1 จุด");

  const list = (items: string[]) => items.slice(0, 4).join(", ") + (items.length > 4 ? ` และอีก ${items.length - 4} รายการ` : "");
  if (peopleChanged) {
    scenario.roomPopulation = roomCounts;
    scenario.roomPopulationTotal = Object.values(roomCounts).reduce((sum, value) => sum + Math.min(40, value), 0);
    if (scenario.roomPopulationTotal === 0) blockers.push("จำนวนคนในทุกห้องเป็น 0 — ไม่มีใครให้จำลอง");
    const assemblyCapacity = editedGraph.nodes.filter((node) => node.type === "assembly" && !deletedAssembly.has(node.id)).reduce((sum, node) => sum + node.capacity, 0);
    if (scenario.roomPopulationTotal > assemblyCapacity) blockers.push(`จำนวนคนรวม ${scenario.roomPopulationTotal.toLocaleString("th-TH")} คน เกินความจุจุดรวมพลทั้งหมด ${assemblyCapacity.toLocaleString("th-TH")} คน — ลดจำนวนคนในห้อง`);
  }
  if (hasGraphEdits(edits)) scenario.graphEdits = edits;

  const applied: string[] = [];
  if (scenario.fires.length) applied.push(`จุดไฟจากหน้าแก้ไข ${scenario.fires.length} จุด (${list(scenario.fires.map((fire) => fire.name))})`);
  for (const area of scenario.restricted) applied.push(area.edgeIds.length ? `${area.name}: ปิด ${area.edgeIds.length} ช่วงทางที่ผ่านพื้นที่นี้` : `${area.name}: ไม่ทับเส้นทางเดินใด (ไม่มีผล)`);
  const switchedOff = scenario.disabledEdgeIds.length - deletedEdges.length;
  if (deletedNodes.length) applied.push(`ลบจุด ${deletedNodes.length} จุด (${list(deletedNodes)}) — ปิดทุกเส้นทางที่ต่อกับจุดนั้น`);
  if (deletedEdges.length) applied.push(`ลบเส้นทาง ${deletedEdges.length} เส้น — ถือเป็นทางที่ปิด`);
  if (switchedOff > 0) applied.push(`ปิดเส้นทางที่สั่งปิด/ต่อกับจุดที่ลบ รวม ${switchedOff} เส้น`);
  if (narrowed.length) applied.push(`ทางแคบลง/ความจุลดลง ${narrowed.length} เส้น (${list(narrowed)})`);
  if (oneWay.length) applied.push(`ทางเดินทางเดียว ${oneWay.length} เส้น (${list(oneWay)})`);
  const okMoved = movedNames.filter((name) => !movedEdgeLabels.get(name)?.some((label) => failed.has(label)));
  const okRebent = rebent.filter((id) => !failed.has(`เส้นทาง ${id}`));
  const okAdded = added.filter((id) => !failed.has(`เส้นทางใหม่ ${id}`));
  if (okMoved.length) applied.push(`ย้ายจุด ${okMoved.length} จุด (${list(okMoved)}) — ตรวจพื้นและผนังในโมเดลแล้ว`);
  if (okRebent.length) applied.push(`ปรับแนวเส้นทาง ${okRebent.length} เส้น — ตรวจพื้นและผนังในโมเดลแล้ว`);
  if (okAdded.length) applied.push(`เส้นทางใหม่ ${okAdded.length} เส้น${newNodeIds.size ? ` และจุดใหม่ ${newNodeIds.size} จุด` : ""} — ตรวจพื้นและผนังในโมเดลแล้ว`);
  const shrunk = Object.keys(edits.nodeCapacities).map((id) => graph.nodes.get(id)?.name ?? id);
  if (shrunk.length) applied.push(`ลดความจุจุดรวมพล ${shrunk.length} จุด (${list(shrunk)})`);
  if (scenario.roomPopulation) applied.push(`จำนวนคนตามที่แก้ในหน้าแก้ไข รวม ${scenario.roomPopulationTotal.toLocaleString("th-TH")} คน (แทนแถบประชากร)`);
  if (drift.length) notes.push(`โครงสร้างที่บันทึกไว้ต่างจากโมเดลจริง ${drift.length} รายการ (${list(drift)}) — การจำลองใช้ตำแหน่งจริงของห้อง บันได ทางออก และจุดรวมพล · กด “จัดให้ตรงโมเดลจริง” เพื่อให้ผังตรงกัน`);
  if (visualOnly.length) notes.push(`แก้เฉพาะรูปร่าง/ป้าย ไม่มีผลกับการเดิน: ${list(visualOnly)}`);
  if (scenario.graphEdits && !blockers.length) notes.push("มือถือจำลองยังนำทางด้วยผังมาตรฐาน (รวมทางที่ปิดแล้ว) — จุดที่ย้ายและทางใหม่ใช้กับคนในแบบจำลองเท่านั้น");

  // People who would have no way to any assembly area at all (before any fire).
  if (!blockers.length && (closed.size || scenario.graphEdits || scenario.restricted.length)) {
    const shut = new Set([...closed, ...scenario.restricted.flatMap((area) => area.edgeIds)]);
    const next = new Map<string, string[]>();
    for (const edge of editedGraph.edges) {
      if (shut.has(edge.id)) continue;
      (next.get(edge.to) ?? next.set(edge.to, []).get(edge.to)!).push(edge.from); // reverse search from goals
      if (edge.twoWay) (next.get(edge.from) ?? next.set(edge.from, []).get(edge.from)!).push(edge.to);
    }
    const reach = new Set(editedGraph.nodes.filter((node) => node.type === "assembly").map((node) => node.id));
    const queue = [...reach];
    while (queue.length) { const id = queue.pop()!; for (const prev of next.get(id) ?? []) if (!reach.has(prev)) { reach.add(prev); queue.push(prev); } }
    const stuck = editedGraph.nodes.filter((node) => node.type === "room" && !reach.has(node.id) && (roomCounts[node.id] ?? 1) > 0);
    if (stuck.length) notes.push(`⚠ ${stuck.length} ห้องจะไม่มีทางไปจุดรวมพลเลย (${list(stuck.map((node) => node.name))}) — ผลจำลองจะนับเป็นผู้ติดค้าง`);
  }

  const standardSame = !blockers.length && !applied.length;
  return { runnable: blockers.length === 0, standard: standardSame && !drift.length, blockers, applied, notes, driftCount: drift.length, scenario: blockers.length ? EMPTY : scenario };
}

/**
 * “จัดให้ตรงโมเดลจริง”: put standard structure back where the model has it — classroom, stair, exit
 * and assembly shapes, item types and floors, stair lines, passage types and ends, and passages saved
 * under an earlier id. Everything the user decided is kept: names, notes, people per room, closed or
 * narrowed passages, one-way, moved doors/corridor points, new points and passages, scenario markers.
 */
export function alignToModel(map: Pick<SemanticMapFile, "annotations" | "connections">): { annotations: SemanticAnnotation[]; connections: SemanticMapFile["connections"]; changed: number } {
  const standard = standardMap();
  const graph = standardGraph();
  const templateNodes = new Map(standard.annotations.map((node) => [node.id, node]));
  const templateEdges = new Map(standard.connections.map((edge) => [edge.id, edge]));
  let changed = 0;
  const annotations = map.annotations.map((node) => {
    const base = templateNodes.get(node.id);
    if (!base) return node;
    const simNode = graph.nodes.get(node.id);
    const structure = !simNode || !MOVABLE_TYPES.has(simNode.type);
    const typeDrift = node.type !== base.type || node.shape !== base.shape || node.floor !== base.floor;
    const shapeDrift = structure && (!sameVec(node.position, base.position) || nodeShapeChanged(node, base));
    const capacityOk = sameNumber(node.capacity, base.capacity) || (simNode?.type === "assembly" && node.capacity >= 1 && node.capacity < base.capacity);
    if (!typeDrift && !shapeDrift && capacityOk) return node;
    changed += 1;
    return {
      ...node, type: base.type, shape: base.shape, floor: base.floor,
      ...(structure || typeDrift ? { position: [...base.position] as Vec3, rotation: [...base.rotation] as Vec3, size: [...base.size] as Vec3 } : {}),
      capacity: capacityOk ? node.capacity : base.capacity,
    };
  });
  const present = new Set(map.connections.map((edge) => edge.id));
  const connections = map.connections.map((edge) => {
    const aliasId = LEGACY_EDGE_IDS[edge.id];
    if (aliasId && !present.has(aliasId)) {
      const base = templateEdges.get(aliasId)!;
      changed += 1;
      return { ...edge, id: base.id, fromId: base.fromId, toId: base.toId, type: base.type, waypoints: (base.waypoints ?? []).map((p) => [...p] as Vec3) };
    }
    const base = templateEdges.get(edge.id);
    if (!base) return edge;
    const stair = graph.edges.find((item) => item.id === edge.id)?.kind === "stair";
    const endsDrift = edge.fromId !== base.fromId || edge.toId !== base.toId || edge.type !== base.type;
    const lineDrift = stair && !samePoints(edge.waypoints ?? [], base.waypoints ?? []);
    if (!endsDrift && !lineDrift) return edge;
    changed += 1;
    return { ...edge, fromId: base.fromId, toId: base.toId, type: base.type, ...(lineDrift || endsDrift ? { waypoints: (base.waypoints ?? []).map((p) => [...p] as Vec3) } : {}) };
  });
  return { annotations, connections, changed };
}
