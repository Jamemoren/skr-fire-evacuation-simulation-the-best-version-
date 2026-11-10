/**
 * Network changes made in the model editor, applied to the simulator's graph when a run starts.
 * Every change here has already passed the editor's physical check (modelPhysics) or only narrows
 * what the standard network allows (narrower, lower capacity, one-way).
 */
import type { SimEdge, SimGraph, SimNode, Vec3 } from "./types";

export interface GraphEdits {
  /** Standard path nodes moved in the editor (simulator coordinates). */
  nodePositions: Record<string, Vec3>;
  /** Assembly areas given a lower capacity in the editor. */
  nodeCapacities: Record<string, number>;
  /** Standard passages narrowed, slowed, made one-way, or re-bent in the editor. */
  edgeOverrides: Record<string, { width?: number; capacityPerSecond?: number; twoWay?: boolean; waypoints?: Vec3[] }>;
  addedNodes: SimNode[];
  addedEdges: Array<Omit<SimEdge, "distance" | "floorFrom" | "floorTo">>;
}

export const hasGraphEdits = (edits: GraphEdits | null | undefined): edits is GraphEdits => !!edits && (
  Object.keys(edits.nodePositions).length > 0 || Object.keys(edits.nodeCapacities ?? {}).length > 0 || Object.keys(edits.edgeOverrides).length > 0
  || edits.addedNodes.length > 0 || edits.addedEdges.length > 0);

const length = (points: Vec3[]) => points.slice(1).reduce((sum, point, index) => {
  const prev = points[index];
  return sum + Math.hypot(point[0] - prev[0], point[1] - prev[1], point[2] - prev[2]);
}, 0);

export function edgePolyline(edge: Pick<SimEdge, "from" | "to" | "waypoints">, nodes: Map<string, Pick<SimNode, "position">>): Vec3[] {
  const from = nodes.get(edge.from)?.position, to = nodes.get(edge.to)?.position;
  if (!from || !to) return [];
  return [from, ...(edge.waypoints ?? []), to].map((point) => [...point] as Vec3);
}

/** A new graph with the edits applied; the input graph is not changed. */
export function applyGraphEdits(graph: SimGraph, edits: GraphEdits | null | undefined): SimGraph {
  if (!hasGraphEdits(edits)) return graph;
  const nodes: SimNode[] = graph.nodes.map((node) => {
    const position = edits.nodePositions[node.id], capacity = edits.nodeCapacities?.[node.id];
    if (!position && capacity === undefined) return node;
    return { ...node, ...(position ? { position: [...position] as Vec3 } : {}), ...(capacity !== undefined ? { capacity } : {}) };
  });
  const existing = new Set(nodes.map((node) => node.id));
  for (const node of edits.addedNodes) if (!existing.has(node.id)) { nodes.push({ ...node, position: [...node.position] as Vec3 }); existing.add(node.id); }
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const finish = (edge: Omit<SimEdge, "distance" | "floorFrom" | "floorTo"> & Partial<SimEdge>): SimEdge | null => {
    const from = nodeMap.get(edge.from), to = nodeMap.get(edge.to);
    if (!from || !to) return null;
    return { ...edge, distance: Math.max(0.1, length(edgePolyline(edge, nodeMap))), floorFrom: from.floor, floorTo: to.floor } as SimEdge;
  };
  const edges: SimEdge[] = [];
  for (const edge of graph.edges) {
    const override = edits.edgeOverrides[edge.id];
    const moved = !!(edits.nodePositions[edge.from] || edits.nodePositions[edge.to]);
    if (!override && !moved) { edges.push(edge); continue; }
    const next = finish({ ...edge, ...override, waypoints: override?.waypoints ?? edge.waypoints });
    if (next) edges.push(next);
  }
  const edgeIds = new Set(edges.map((edge) => edge.id));
  for (const edge of edits.addedEdges) {
    if (edgeIds.has(edge.id)) continue;
    const next = finish(edge);
    if (next) { edges.push(next); edgeIds.add(edge.id); }
  }
  return { nodes, edges };
}
