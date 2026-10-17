import { useEffect, type RefObject } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { createEvacuationGraph, traversalPoints } from "../simulation/graph";
import { PEDESTRIAN_RADIUS } from "../simulation/walkable";
import { useBuilding1Store } from "./building1Store";

/** Opt-in inspection of the actual mounted geometry, including hidden batch sources.
 * Open ?architecturalAudit=1. No work runs during ordinary use. This checks the
 * route centreline with a 36 cm body and 1.90 m headroom; it is not a building survey.
 */
export function ArchitecturalAudit({ rootRef }: { rootRef: RefObject<THREE.Group | null> }) {
  const gl = useThree((state) => state.gl);
  const mode = useBuilding1Store((state) => state.viewMode);
  const floor = useBuilding1Store((state) => state.selectedFloor);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  useEffect(() => {
    if (new URLSearchParams(location.search).get("architecturalAudit") !== "1" || explode) return;
    const timer = window.setTimeout(() => {
      const root = rootRef.current;
      if (!root) return;
      root.updateWorldMatrix(true, true);
      const candidates: { mesh: THREE.Mesh; box: THREE.Box3; label: string; solidBox: boolean }[] = [];
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
        const names: string[] = [];
        for (let p: THREE.Object3D | null = mesh; p && p !== root; p = p.parent) names.push(p.name);
        const label = names.filter(Boolean).join("/");
        if (!/CORE_ENCLOSURE|LIFT_SHAFT|_PARTITION_|_ROOM_FRONT_|_OUTER_WALL|ROUNDED_ENCLOSED_TOWER|SWITCHBACK_STAIR|STAIR_VOID_GUARD|_SLAB|ACCESS_LANDING/.test(label)) return;
        // Doors are animated and deliberately excluded; their stationary wall jambs
        // are still present. Furniture is outside this architecture clearance check.
        if (/_DOOR_|CORRIDOR_WINDOW/.test(label)) return;
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
        candidates.push({ mesh, box, label, solidBox: mesh.geometry.type === "BoxGeometry" && Math.abs(new THREE.Vector3(0, 1, 0).transformDirection(mesh.matrixWorld).y) > .999 });
      });
      const grid = new Map<string, typeof candidates>();
      const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
      for (const item of candidates) {
        for (let x = Math.floor(item.box.min.x / 4); x <= Math.floor(item.box.max.x / 4); x++) {
          for (let y = Math.floor(item.box.min.y / 3.5); y <= Math.floor(item.box.max.y / 3.5); y++) {
            for (let z = Math.floor(item.box.min.z / 4); z <= Math.floor(item.box.max.z / 4); z++) {
              const k = key(x, y, z);
              const items = grid.get(k) ?? [];
              items.push(item); grid.set(k, items);
            }
          }
        }
      }
      const graph = createEvacuationGraph();
      const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
      const issues = new Map<string, { edge: string; object: string; point: number[]; kind: string }>();
      const ray = new THREE.Raycaster();
      const hits: THREE.Intersection[] = [];
      const down = new THREE.Vector3(0, -1, 0);
      const up = new THREE.Vector3(0, 1, 0);
      const body = new THREE.Box3();
      const origin = new THREE.Vector3();
      let samples = 0, edges = 0;
      const visible = (f: number) => mode === "interior" || mode === "single-floor" ? f === floor : mode === "cutaway" ? f <= floor : true;
      for (const edge of graph.edges) {
        if (!edge.insideBuilding) continue;
        if (edge.kind === "stair" ? !visible(edge.floorFrom) || !visible(edge.floorTo) : !visible(edge.floorFrom)) continue;
        const path = traversalPoints(edge, nodes, edge.from, edge.to);
        edges++;
        for (let i = 1; i < path.length; i++) {
          const a = new THREE.Vector3(...path[i - 1]), b = new THREE.Vector3(...path[i]);
          const count = Math.max(1, Math.ceil(a.distanceTo(b) / .16));
          for (let j = 0; j <= count; j++) {
            const p = a.clone().lerp(b, j / count);
            samples++;
            const near = new Set<typeof candidates[number]>();
            for (const dy of [-.5, 0, 1.9]) for (const dx of [-PEDESTRIAN_RADIUS, PEDESTRIAN_RADIUS]) for (const dz of [-PEDESTRIAN_RADIUS, PEDESTRIAN_RADIUS]) {
              grid.get(key(Math.floor((p.x + dx) / 4), Math.floor((p.y + dy) / 3.5), Math.floor((p.z + dz) / 4)))?.forEach((item) => near.add(item));
            }
            body.min.set(p.x - PEDESTRIAN_RADIUS, p.y + .34, p.z - PEDESTRIAN_RADIUS);
            body.max.set(p.x + PEDESTRIAN_RADIUS, p.y + 1.9, p.z + PEDESTRIAN_RADIUS);
            let supported = false;
            const record = (kind: string, label: string) => {
              const k = `${edge.id}:${kind}:${label}`;
              if (!issues.has(k)) issues.set(k, { edge: edge.id, object: label, kind, point: p.toArray().map((n) => +n.toFixed(3)) });
            };
            for (const item of near) {
              if (item.box.intersectsBox(body)) {
                if (item.solidBox) record("body-obstruction", item.label);
                else for (const [dx, dz] of [[0, 0], [-PEDESTRIAN_RADIUS, 0], [PEDESTRIAN_RADIUS, 0], [0, -PEDESTRIAN_RADIUS], [0, PEDESTRIAN_RADIUS]]) {
                  origin.set(p.x + dx, p.y + .34, p.z + dz);
                  ray.set(origin, up); ray.near = 0; ray.far = 1.56; hits.length = 0;
                  THREE.Mesh.prototype.raycast.call(item.mesh, ray, hits);
                  if (hits.length) record("headroom-or-rail", item.label);
                }
              }
              if (!supported && item.box.max.y >= p.y - .55 && item.box.min.y <= p.y + .31
                && item.box.min.x <= p.x && item.box.max.x >= p.x && item.box.min.z <= p.z && item.box.max.z >= p.z) {
                origin.set(p.x, p.y + .31, p.z); ray.set(origin, down); ray.near = 0; ray.far = .86; hits.length = 0;
                THREE.Mesh.prototype.raycast.call(item.mesh, ray, hits);
                supported = hits.length > 0;
              }
            }
            if (!supported) record("unsupported", "floor-or-stair");
          }
        }
      }
      const report = { mode, floor, bodyRadius: PEDESTRIAN_RADIUS, headroom: 1.9, spacing: .16, meshes: candidates.length, edges, samples, issues: [...issues.values()] };
      gl.domElement.dataset.architecturalAudit = JSON.stringify(report);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [rootRef, gl, mode, floor, explode]);
  return null;
}
