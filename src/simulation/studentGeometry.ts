import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { STUDENT_BODY_HEIGHT } from "../building1/building1Data";

export type StudentGender = "male" | "female";
type Point = [number, number, number];

/** Shared uniform mesh: body parts and rig data remain in one draw call per gender. */
export function createStudentGeometry(gender: StudentGender = "male", compact = false): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const skin = "#dca880", hair = "#27211e", shirt = "#f3f5f3", navy = "#253c59";
  const segments = compact ? 6 : 8;
  function add(geometry: THREE.BufferGeometry, colorValue: string, at: Point, rig = 0, pivot: Point = [0, 0, 0], feature = 0) {
    geometry.translate(...at);
    const count = geometry.getAttribute("position").count;
    const colors = new Float32Array(count * 3), rigs = new Float32Array(count * 4), features = new Float32Array(count);
    const color = new THREE.Color(colorValue);
    for (let i = 0; i < count; i++) {
      colors.set([color.r, color.g, color.b], i * 3);
      rigs.set([...pivot, rig], i * 4);
      features[i] = feature;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("studentRig", new THREE.BufferAttribute(rigs, 4));
    geometry.setAttribute("studentFeature", new THREE.BufferAttribute(features, 1));
    parts.push(geometry);
  }
  function oval(size: Point) {
    const large = Math.max(...size) > .06;
    return new THREE.SphereGeometry(1, large ? segments : compact ? 4 : 6, large ? compact ? 4 : 6 : 3).scale(...size);
  }
  function roundedBox(size: Point, bevel = .012) {
    const [w, h, d] = size;
    const b = Math.min(bevel, w / 4, h / 4, d / 4);
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + b, -h / 2 + b);
    shape.lineTo(w / 2 - b, -h / 2 + b);
    shape.lineTo(w / 2 - b, h / 2 - b);
    shape.lineTo(-w / 2 + b, h / 2 - b);
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth: d - 2 * b, bevelEnabled: true,
      bevelSize: b, bevelThickness: b, bevelSegments: 1, steps: 1, curveSegments: 1 }).translate(0, 0, -d / 2 + b);
  }
  function box(size: Point, at: Point, color: string) { add(new THREE.BoxGeometry(...size), color, at); }
  function collarTriangle(points: Point[]) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
    geometry.setIndex([0, 2, 1]);
    geometry.computeVertexNormals();
    add(geometry, "#ffffff", [0, 0, 0]);
  }

  add(roundedBox([.326, .39, .176]), shirt, [0, 1.065, 0]);
  add(oval([.18, .075, .091]), shirt, [0, 1.215, 0]);
  add(new THREE.CylinderGeometry(.043, .049, .096, segments), skin, [0, 1.278, 0], 0, [0, 0, 0], 1);
  add(oval([.105, .137, .098]), skin, [0, 1.422, .002], 0, [0, 0, 0], 1);
  for (const side of [-1, 1]) {
    const hip: Point = [side * .081, .815, 0], shoulder: Point = [side * .182, 1.218, 0];
    add(oval([.025, .039, .023]), skin, [side * .102, 1.414, .001], 0, [0, 0, 0], 1);
    add(oval([.065, .105, .084]), shirt, [side * .185, 1.171, 0], side, shoulder);
    add(new THREE.CylinderGeometry(.036, .029, .195, segments), skin, [side * .211, .998, 0], side, shoulder, 1);
    add(oval([.032, .048, .028]), skin, [side * .214, .879, .006], side, shoulder, 1);
    add(new THREE.CylinderGeometry(.042, .033, .30, segments), skin, [side * .081, .424, 0], side * 3, [side * .081, .56, 0], 1);
    add(new THREE.CylinderGeometry(.034, .038, .178, segments), "#e8ede9", [side * .081, .203, 0], side * 3, [side * .081, .56, 0]);
    add(roundedBox([.098, .075, .183], .018), "#252a30", [side * .081, .081, .028], side * 3, [side * .081, .56, 0]);
    if (!compact) {
      add(roundedBox([.1, .018, .187], .004), "#151e27", [side * .081, .052, .028], side * 3, [side * .081, .56, 0]);
      add(new THREE.BoxGeometry(.04, .005, .028), "#69717a", [side * .081, .116, .052], side * 3, [side * .081, .56, 0]);
    }
    if (gender === "male") add(roundedBox([.143, .29, .19]), navy, [side * .08, .718, 0], side * 2, hip);
  }
  if (gender === "female") {
    const n = compact ? 8 : 12;
    const skirt = new THREE.CylinderGeometry(.15, .222, .33, n * 2, 1);
    const p = skirt.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const angle = Math.atan2(p.getZ(i), p.getX(i));
      const pleat = Math.cos(angle * n) * .018;
      p.setXYZ(i, p.getX(i) * (1 + pleat), p.getY(i), p.getZ(i) * .67 * (1 + pleat));
    }
    skirt.computeVertexNormals();
    add(skirt, navy, [0, .699, 0]);
    box([.302, .034, .163], [0, .862, 0], "#20354f");
    add(new THREE.SphereGeometry(.115, segments, compact ? 4 : 6, Math.PI, Math.PI, .7, 1.55).scale(1, 1.15, 1), hair, [0, 1.425, -.004], 0, [0, 0, 0], 2);
    for (const side of [-1, 1]) add(oval([.023, .095, .06]), hair, [side * .101, 1.421, -.025], 0, [0, 0, 0], 2);
    box([.07, .022, .019], [0, 1.393, -.113], "#182d49");
    for (const side of [-1, 1]) {
      const bow = new THREE.BoxGeometry(.047, .026, .018);
      bow.rotateZ(side * .23);
      add(bow, "#253e62", [side * .025, 1.184, .103]);
    }
    box([.018, .024, .022], [0, 1.184, .107], "#1d304b");
  } else {
    box([.302, .028, .184], [0, .873, 0], "#293033");
    box([.031, .025, .009], [0, .873, .098], "#b59c61");
    add(new THREE.SphereGeometry(.109, segments, compact ? 3 : 5, Math.PI, Math.PI, .75, 1.1).scale(1, 1.08, 1), hair, [0, 1.442, -.004], 0, [0, 0, 0], 2);
    const fringe = oval([.079, .027, .034]);
    fringe.rotateZ(-.13);
    add(fringe, hair, [-.018, 1.514, .066], 0, [0, 0, 0], 2);
  }
  add(new THREE.SphereGeometry(.112, segments, compact ? 3 : 5, 0, Math.PI * 2, 0, 1.18).scale(1, 1.18, 1), hair, [0, 1.448, -.004], 0, [0, 0, 0], 2);
  collarTriangle([[-.07, 1.257, .07], [-.012, 1.222, .099], [-.051, 1.181, .1]]);
  collarTriangle([[.07, 1.257, .07], [.051, 1.181, .1], [.012, 1.222, .099]]);
  for (const side of [-1, 1]) {
    add(oval([.011, .006, .003]), "#ede8df", [side * .037, 1.445, .095]);
    add(oval([.0045, .0055, .003]), "#302923", [side * .037, 1.445, .098]);
    if (!compact) {
      const brow = new THREE.BoxGeometry(.023, .004, .004);
      brow.rotateZ(side * -.09);
      add(brow, hair, [side * .037, 1.466, .094], 0, [0, 0, 0], 2);
    }
  }
  add(oval([.012, .021, .014]), "#cb9470", [0, 1.414, .098], 0, [0, 0, 0], 1);
  add(oval([.018, .0035, .003]), "#a56a5c", [0, 1.379, .093]);
  if (!compact) {
    box([.052, .054, .004], [.083, 1.122, .091], "#e1e7e7");
    box([.051, .007, .006], [.083, 1.149, .094], "#fafbfa");
    box([.034, .009, .005], [-.083, 1.159, .092], "#476384");
    box([.024, .006, .005], [-.083, 1.143, .092], "#6b7f96");
    for (const y of [1.13, 1.065, 1.0, .935]) add(oval([.004, .004, .003]), "#bac5ca", [0, y, .092]);
    box([.006, .245, .003], [0, 1.056, .09], "#e6ebea");
  }
  const compatible = parts.map(part => {
    part.deleteAttribute("uv");
    return part.index ? part.toNonIndexed() : part;
  });
  const joined = mergeGeometries(compatible, false);
  new Set([...parts, ...compatible]).forEach(part => part.dispose());
  if (!joined) throw new Error("สร้าง geometry นักเรียนไม่สำเร็จ");
  // Recover shared vertices after merging bevelled and smooth primitives.
  const merged = mergeVertices(joined, 0.00001);
  joined.dispose();
  merged.computeBoundingBox();
  const factor = STUDENT_BODY_HEIGHT / merged.boundingBox!.max.y;
  merged.scale(1, factor, 1);
  const rigs = merged.getAttribute("studentRig");
  for (let i = 0; i < rigs.count; i++) rigs.setY(i, rigs.getY(i) * factor);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}
