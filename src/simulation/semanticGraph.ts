import {
  ASSEMBLY_ZONE_CAPACITY,
  BUILDING_ID,
  CLASSROOMS,
  FIELD_CENTER,
  FIELD_SIZE,
  FLOOR_COUNT,
  FLOOR_HEIGHT,
  FULL_BUILDING_CAPACITY,
  TARGET_POPULATION,
  floorCenter,
  type RoomModuleDefinition,
} from "../building1/building1Data";
import { DIGITAL_MODEL_NAME_TH, GENERATED_MODEL_HASH, PROJECT_DESCRIPTION_TH, PROJECT_NAME_TH, SCHOOL_NAME_TH } from "../projectIdentity";
import type {
  AnnotationShape,
  AnnotationType,
  SemanticAnnotation,
  SemanticConnection,
  SemanticMapFile,
  Vec3,
} from "../types";
import type { SimEdge, SimNode } from "./types";
import { createEvacuationGraph } from "./graph";

const MODEL_HASH = GENERATED_MODEL_HASH;
const SCHOOL_NAME = SCHOOL_NAME_TH;

function annotationTypeForNode(node: SimNode): AnnotationType {
  switch (node.type) {
    case "room": return "classroom";
    case "door": return "door";
    case "corridor": return "hallway";
    case "junction": return "navigation-node";
    case "stair": return "stair";
    case "exit": return "exit";
    case "gate": return "navigation-node";
    case "assembly": return "assembly-area";
  }
}

function connectionTypeForEdge(edge: SimEdge): SemanticConnection["type"] {
  if (edge.kind === "room" || (edge.kind === "exit" && edge.insideBuilding)) return "doorway";
  if (edge.kind === "stair") return "stair";
  if (edge.kind === "outdoor" || (edge.kind === "exit" && !edge.insideBuilding)) return "outdoor-path";
  return "walkway";
}

function shapeForNode(node: SimNode): AnnotationShape {
  return node.type === "room" || node.type === "corridor" || node.type === "assembly" ? "box" : "point";
}

function classroomForNode(node: SimNode): RoomModuleDefinition | undefined {
  return node.type === "room" ? CLASSROOMS.find((room) => room.id === node.id) : undefined;
}

function physicalPosition(node: SimNode, room: RoomModuleDefinition | undefined): Vec3 {
  if (room) return [...room.position] as Vec3;
  if (node.type === "door" && node.id.startsWith("sim-door-")) {
    const owner = CLASSROOMS.find((candidate) => `sim-door-${candidate.id}` === node.id);
    if (owner) return [node.position[0], (owner.floor - 1) * FLOOR_HEIGHT + 1.23, node.position[2]];
  }
  return [...node.position] as Vec3;
}

function sizeForNode(node: SimNode, room: RoomModuleDefinition | undefined): Vec3 {
  if (room) return [...room.size] as Vec3;
  switch (node.type) {
    case "door": return [1.12, 2.36, 0.18];
    case "corridor": return node.wing === "pink" ? [8, 0.3, Math.max(2.2, node.capacity / 4)] : [Math.max(2.2, node.capacity / 4), 0.3, 8];
    case "stair": return [2.2, FLOOR_HEIGHT, 5.8];
    case "exit": return [2.4, 2.62, 0.25];
    case "assembly": return [17.5, 0.2, 12.5];
    default: return [1, 1, 1];
  }
}

function sourcePathForNode(node: SimNode, room: RoomModuleDefinition | undefined): string {
  if (room) return `/BUILDING_1/FLOOR_${room.floor}/${room.id}`;
  if (node.type === "door" && node.id.startsWith("sim-door-")) {
    const owner = CLASSROOMS.find((candidate) => `sim-door-${candidate.id}` === node.id);
    if (owner) return `/BUILDING_1/FLOOR_${owner.floor}/${owner.id}/DOOR`;
  }
  if (node.type === "assembly") return `/SITE/SPORTS_FIELD/${node.id}`;
  return `/NAVIGATION/${node.id}`;
}

function semanticNode(node: SimNode, timestamp: string): SemanticAnnotation {
  const room = classroomForNode(node);
  const type = annotationTypeForNode(node);
  const peopleCount = room?.peopleCount ?? 0;
  const buildingId = node.phase === "outdoor" || node.phase === "assembly" ? "sports-field" : BUILDING_ID;
  return {
    id: node.id,
    type,
    shape: shapeForNode(node),
    name: node.name,
    position: physicalPosition(node, room),
    rotation: [0, 0, 0],
    size: sizeForNode(node, room),
    buildingId,
    floor: node.floor,
    peopleCount,
    capacity: room?.capacity ?? node.capacity,
    notes: node.type === "room"
      ? "ห้องจำลองสำหรับ Scenario 3,000 คน โดย topology ชุดนี้ mirror จาก Simulation Graph โดยตรง"
      : "ข้อมูลโครงข่ายนำทางชุดเดียวกับระบบจำลอง เพื่อให้ข้อมูลแผนที่และการคำนวณเส้นทางสอดคล้องกัน",
    tags: ["simulation-graph-mirror", `node-${node.type}`, `wing-${node.wing}`, `phase-${node.phase}`],
    visible: node.type === "room" || node.type === "door" || node.type === "stair" || node.type === "assembly",
    locked: node.type !== "room" && node.type !== "door",
    sourceObjectName: node.id,
    sourceObjectPath: sourcePathForNode(node, room),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function semanticEdge(edge: SimEdge): SemanticConnection {
  return {
    id: edge.id,
    fromId: edge.from,
    toId: edge.to,
    type: connectionTypeForEdge(edge),
    width: edge.width,
    capacityPerSecond: edge.capacityPerSecond,
    bidirectional: edge.twoWay,
    enabled: true,
    notes: `Mirror จาก Simulation Graph · ${edge.kind} · ${edge.insideBuilding ? "indoor" : "outdoor"}`,
  };
}

/**
 * Single-source-of-truth Semantic Map for the current simulation model.
 *
 * The previous generated map contained simplified Door -> Stair links while the runtime
 * used a much richer Room -> Door -> Corridor -> Junction -> Stair graph. That allowed
 * the editor/exported JSON to describe a different evacuation topology from the actual
 * simulation. The current model mirrors every simulation node and edge into the Semantic Map so QA,
 * editor inspection, exports, and runtime all describe the same physical route network.
 */
export function buildGeneratedSemanticMap(): SemanticMapFile {
  const now = new Date().toISOString();
  const graph = createEvacuationGraph();
  const annotations: SemanticAnnotation[] = [
    {
      id: BUILDING_ID,
      type: "building",
      shape: "box",
      name: "ตึก 1",
      position: [-16, FLOOR_COUNT * FLOOR_HEIGHT / 2, 18],
      rotation: [0, 0, 0],
      size: [88, FLOOR_COUNT * FLOOR_HEIGHT, 80],
      buildingId: BUILDING_ID,
      floor: null,
      peopleCount: 0,
      capacity: FULL_BUILDING_CAPACITY,
      notes: "แบบจำลองดิจิทัลอาคาร 9 ชั้นและโครงข่ายเส้นทางอพยพ",
      tags: ["evacuation-digital-model", "simulation-graph-mirror"],
      visible: true,
      locked: true,
      sourceObjectName: "BUILDING_1",
      sourceObjectPath: "/BUILDING_1",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "sports-field-assembly",
      type: "football-field",
      shape: "box",
      name: "สนามฟุตบอล / จุดรวมพลหลัก",
      position: FIELD_CENTER,
      rotation: [0, 0, 0],
      size: FIELD_SIZE,
      buildingId: "sports-field",
      floor: 0,
      peopleCount: 0,
      capacity: TARGET_POPULATION,
      notes: `จุดรวมพลหลัก 6 โซน × ${ASSEMBLY_ZONE_CAPACITY} คน รวม ${TARGET_POPULATION.toLocaleString("th-TH")} คน`,
      tags: ["assembly", "safe-zone", "destination", "football-field"],
      visible: true,
      locked: true,
      sourceObjectName: "SPORTS_FIELD",
      sourceObjectPath: "/SITE/SPORTS_FIELD",
      createdAt: now,
      updatedAt: now,
    },
  ];

  for (let floor = 1; floor <= FLOOR_COUNT; floor += 1) {
    annotations.push({
      id: `b1-floor-${floor}`,
      type: "floor",
      shape: "box",
      name: floor === 1 ? "ตึก 1 ชั้นล่าง / ใต้ถุน" : `ตึก 1 ชั้น ${floor}`,
      position: [-16, floorCenter(floor), 18],
      rotation: [0, 0, 0],
      size: [88, FLOOR_HEIGHT, 80],
      buildingId: BUILDING_ID,
      floor,
      peopleCount: 0,
      capacity: floor === 1 ? 0 : CLASSROOMS.filter((room) => room.floor === floor).reduce((sum, room) => sum + room.capacity, 0),
      notes: "กรอบอ้างอิงระดับชั้นของแบบจำลองดิจิทัล",
      tags: [`floor-${floor}`],
      visible: false,
      locked: true,
      sourceObjectName: `B1_FLOOR_${floor}`,
      sourceObjectPath: `/BUILDING_1/FLOOR_${floor}`,
      createdAt: now,
      updatedAt: now,
    });
  }

  annotations.push(...graph.nodes.map((node) => semanticNode(node, now)));
  const connections = graph.edges.map(semanticEdge);

  return {
    schema: "skr-semantic-map",
    version: 2,
    exportedAt: now,
    coordinateSpace: "model-local",
    project: {
      name: PROJECT_NAME_TH,
      schoolName: SCHOOL_NAME,
      description: PROJECT_DESCRIPTION_TH,
      createdAt: now,
      updatedAt: now,
    },
    model: {
      name: DIGITAL_MODEL_NAME_TH,
      size: 0,
      sha256: MODEL_HASH,
      source: "generated",
    },
    calibration: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    modelReport: null,
    annotations,
    connections,
  };
}
