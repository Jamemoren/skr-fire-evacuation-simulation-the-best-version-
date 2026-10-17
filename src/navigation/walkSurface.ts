import { createEvacuationGraph, traversalPoints, walkY } from "../simulation/graph";
import { pointInsideWalkableCorridor, pointClearsCentralLiftBank, pointClearsExteriorBuilding, pointClearsStairVoid } from "../simulation/walkable";
import { ROOM_MODULES } from "../building1/building1Data";
import type { Vec3 } from "../types";

const graph = createEvacuationGraph();
const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
const indoorPaths = graph.edges.filter((edge) => edge.insideBuilding && edge.kind !== "stair" && edge.floorFrom === edge.floorTo)
  .map((edge) => ({ edge, path: traversalPoints(edge, nodes, edge.from, edge.to) }));

/** Planar exploration uses the existing floor topology; stairs are selected in the floor menu. */
export function canWalkAt(x: number, z: number, floor: number): boolean {
  const point: Vec3 = [x, walkY(floor), z];
  if (!pointClearsCentralLiftBank(point) || !pointClearsStairVoid(point)) return false;
  if (floor === 1) {
    if (x < -68 || x > 59 || z < -20 || z > 136 || !pointClearsExteriorBuilding(point)) return false;
    // Rear concrete enclosure and the courtyard monument are solid at ground level.
    if (x > -52.3 && x < 10.2 && Math.abs(z + 9.88) < 0.36) return false;
    if (z > -10.2 && z < 52.3 && Math.abs(x - 9.88) < 0.36) return false;
    if (Math.hypot(x + 17, z - 18) < 3.75) return false;
    return true;
  }
  // Classroom interiors supplement the narrow door-to-room graph centreline.
  for (const room of ROOM_MODULES) {
    if (room.floor !== floor) continue;
    if (room.side === "pink" && Math.abs(x - room.position[0]) < 3.72 && z > -9.55 && z < -0.26) return true;
    if (room.side === "blue" && Math.abs(z - room.position[2]) < 3.72 && x > 0.46 && x < 9.55) return true;
  }
  return indoorPaths.some(({ edge, path }) => edge.floorFrom === floor && pointInsideWalkableCorridor(point, path, edge));
}
