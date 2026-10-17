import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Shared dimensions keep the masonry, glazing and door frames on the same edges.
export const ROOM_FRONT = {
  doorX: -2.25,
  doorHalfWidth: 0.56,
  doorTop: 2.62,
  windowX: 0.95,
  windowWidth: 5.15,
  windowBottom: 1.05,
  windowTop: 2.43,
  thickness: 0.2,
} as const;

/** One continuous wall, with a floor-level doorway and a separate glazing opening. */
export function createClassroomFront(width: number, floor: number, top: number) {
  const d = ROOM_FRONT;
  const left = d.doorX - d.doorHalfWidth;
  const right = d.doorX + d.doorHalfWidth;
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, floor);
  shape.lineTo(left, floor);
  shape.lineTo(left, d.doorTop);
  shape.lineTo(right, d.doorTop);
  shape.lineTo(right, floor);
  shape.lineTo(width / 2, floor);
  shape.lineTo(width / 2, top);
  shape.lineTo(-width / 2, top);
  shape.closePath();
  const window = new THREE.Path();
  window.moveTo(d.windowX - d.windowWidth / 2, d.windowBottom);
  window.lineTo(d.windowX - d.windowWidth / 2, d.windowTop);
  window.lineTo(d.windowX + d.windowWidth / 2, d.windowTop);
  window.lineTo(d.windowX + d.windowWidth / 2, d.windowBottom);
  window.closePath();
  shape.holes.push(window);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: d.thickness, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, -d.thickness / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Rounded plan corners with straight vertical edges, so stacked storeys meet flush. */
export function createTowerCorner(height: number) {
  const half = 0.56, radius = 0.22;
  const shape = new THREE.Shape();
  shape.moveTo(-half + radius, -half);
  shape.lineTo(half - radius, -half);
  shape.quadraticCurveTo(half, -half, half, -half + radius);
  shape.lineTo(half, half - radius);
  shape.quadraticCurveTo(half, half, half - radius, half);
  shape.lineTo(-half + radius, half);
  shape.quadraticCurveTo(-half, half, -half, half - radius);
  shape.lineTo(-half, -half + radius);
  shape.quadraticCurveTo(-half, -half, -half + radius, -half);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 6 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height / 2, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

type Part = { size: [number, number, number]; at: [number, number, number]; color: string };
function furniture(parts: Part[]) {
  const pieces = parts.map(({ size, at, color }) => {
    const geometry = new THREE.BoxGeometry(...size);
    geometry.translate(...at);
    const rgb = new THREE.Color(color);
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set([rgb.r, rgb.g, rgb.b], i);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geometry;
  });
  const merged = mergeGeometries(pieces, false)!;
  pieces.forEach((geometry) => geometry.dispose());
  merged.computeBoundingBox(); merged.computeBoundingSphere();
  return merged;
}

/** Origin is the finished floor; all desks retain a clear leg space. */
export function createSchoolDesk(width = 1.38, depth = 0.52) {
  const frame = "#647177", wood = "#b08a61";
  const parts: Part[] = [
    { size: [width, 0.06, depth], at: [0, 0.72, 0], color: wood },
    { size: [width - 0.12, 0.05, 0.04], at: [0, 0.66, -depth / 2 + 0.06], color: frame },
    { size: [width - 0.12, 0.05, 0.04], at: [0, 0.66, depth / 2 - 0.06], color: frame },
  ];
  for (const x of [-width / 2 + 0.08, width / 2 - 0.08]) {
    for (const z of [-depth / 2 + 0.07, depth / 2 - 0.07]) {
      parts.push({ size: [0.04, 0.69, 0.04], at: [x, 0.345, z], color: frame });
    }
    parts.push({ size: [0.04, 0.04, depth - 0.10], at: [x, 0.18, 0], color: frame });
  }
  return furniture(parts);
}

export function createSchoolChair() {
  const frame = "#647177", wood = "#967450";
  const parts: Part[] = [
    { size: [0.38, 0.045, 0.38], at: [0, 0.43, 0], color: wood },
    { size: [0.38, 0.20, 0.04], at: [0, 0.70, 0.17], color: wood },
  ];
  for (const x of [-0.15, 0.15]) {
    for (const z of [-0.15, 0.15]) parts.push({ size: [0.028, 0.41, 0.028], at: [x, 0.205, z], color: frame });
    parts.push({ size: [0.028, 0.35, 0.028], at: [x, 0.615, 0.17], color: frame });
  }
  return furniture(parts);
}
