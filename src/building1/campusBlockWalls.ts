/**
 * End walls of the shared Building 3/4 classroom-block asset, rebuilt for the real bridge floor.
 *
 * The asset (campus-classroom-block.glb) was generated with small bridge openings on floor 4 at
 * both ends. The bridge is on floor BRIDGE_FLOOR (3) and only at the inner end of each block
 * (B3's +x end, B4's −x end). This removes the asset's end-wall faces and adds two walls: the
 * outer one solid, the inner one with a walk-through opening on the bridge floor, in line with the
 * gallery. Used by the 3D view and by the triangle-raycast QA, so both check the same geometry.
 *
 * `three` is passed in (not imported) so a Node test and the app can each use their own instance.
 */
import type * as THREE_NS from "three";
import { BLOCK_LEVELS } from "../simulation/campusData";
import { BRIDGE_FLOOR } from "../simulation/bridge";

type Three = typeof THREE_NS;

/** Opening on the inner end wall (block-local metres), on the bridge floor. */
export const BRIDGE_OPENING = {
  yLow: BLOCK_LEVELS[BRIDGE_FLOOR - 1] + 0.025,
  yHigh: BLOCK_LEVELS[BRIDGE_FLOOR - 1] + 2.9,
  z0: 1.65,
  z1: 4.4,
};
const WALL = { bottom: 0.16, top: 14.55, zMin: -7.5, zMax: 7.5, thickness: 0.28, x: 38 };
const FACADE = "Reference pink facade";

/**
 * Mutates `block`: drops end-wall triangles from the facade mesh (cloned geometry, so the cached
 * asset is untouched) and adds the rebuilt walls. Returns every geometry it created (dispose them).
 */
export function rebuildBlockEndWalls(three: Three, block: THREE_NS.Object3D, innerSign: 1 | -1): THREE_NS.BufferGeometry[] {
  const created: THREE_NS.BufferGeometry[] = [];
  let facade: THREE_NS.Material | undefined;
  block.traverse((object) => {
    const mesh = object as THREE_NS.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material) || mesh.material.name !== FACADE) return;
    facade ??= mesh.material;
    if (!mesh.geometry.index) return;
    const geometry = mesh.geometry.clone();
    const index = geometry.index!;
    const position = geometry.getAttribute("position");
    const keep: number[] = [];
    for (let t = 0; t < index.count; t += 3) {
      const ids = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      // End-wall faces sit at |x| 37.86–38.14 (wall centred on ±38, 0.28 thick); nothing else does.
      const endWall = ids.every((i) => { const ax = Math.abs(position.getX(i)); return ax > 37.8 && ax < 38.16; });
      if (!endWall) keep.push(...ids);
    }
    geometry.setIndex(keep);
    mesh.geometry = geometry;
    created.push(geometry);
  });
  const piece = (x: number, y0: number, y1: number, z0: number, z1: number, name: string) => {
    const geometry = new three.BoxGeometry(WALL.thickness, y1 - y0, z1 - z0);
    created.push(geometry);
    const mesh = new three.Mesh(geometry, facade);
    mesh.name = name;
    mesh.position.set(x, (y0 + y1) / 2, (z0 + z1) / 2);
    block.add(mesh);
  };
  const inner = innerSign * WALL.x, outer = -inner;
  const o = BRIDGE_OPENING;
  piece(outer, WALL.bottom, WALL.top, WALL.zMin, WALL.zMax, "END_WALL_OUTER");
  piece(inner, WALL.bottom, o.yLow, WALL.zMin, WALL.zMax, "END_WALL_INNER_BELOW_BRIDGE");
  piece(inner, o.yHigh, WALL.top, WALL.zMin, WALL.zMax, "END_WALL_INNER_ABOVE_BRIDGE");
  piece(inner, o.yLow, o.yHigh, WALL.zMin, o.z0, "END_WALL_INNER_BESIDE_BRIDGE_A");
  piece(inner, o.yLow, o.yHigh, o.z1, WALL.zMax, "END_WALL_INNER_BESIDE_BRIDGE_B");
  return created;
}
