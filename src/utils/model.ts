import * as THREE from "three";
import type { ModelReport, ModelReportItem, SurfaceHit, Vec3 } from "../types";

function vec3(vector: THREE.Vector3): Vec3 {
  return [vector.x, vector.y, vector.z];
}

function objectPath(object: THREE.Object3D): string {
  const names: string[] = [];
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    names.unshift(cursor.name || cursor.type);
    cursor = cursor.parent;
  }
  return names.join("/");
}

function materialNames(material: THREE.Material | THREE.Material[]): string[] {
  const materials = Array.isArray(material) ? material : [material];
  return materials.map((item) => item.name || item.type);
}

function meshTriangles(mesh: THREE.Mesh): number {
  const geometry = mesh.geometry;
  if (geometry.index) return Math.floor(geometry.index.count / 3);
  const position = geometry.getAttribute("position");
  return position ? Math.floor(position.count / 3) : 0;
}

export function surfaceHitFromIntersection(
  intersection: THREE.Intersection,
  modelRoot?: THREE.Object3D | null,
): SurfaceHit {
  const object = intersection.object;
  const mesh = object as THREE.Mesh;
  const normal = intersection.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
  normal.applyMatrix3(normalMatrix).normalize();
  const material = mesh.isMesh ? mesh.material : null;
  const worldPoint = intersection.point.clone();
  const localPoint = modelRoot
    ? modelRoot.worldToLocal(worldPoint.clone())
    : worldPoint.clone();
  return {
    position: vec3(localPoint),
    worldPosition: vec3(worldPoint),
    normal: vec3(normal),
    objectName: object.name || object.type,
    objectPath: objectPath(object),
    materialName: material
      ? materialNames(material).join(", ")
      : "",
    triangleCount: mesh.isMesh ? meshTriangles(mesh) : 0,
  };
}

export function buildModelReport(
  root: THREE.Object3D,
  modelName: string,
  fileSize: number,
  sha256: string,
): ModelReport {
  root.updateWorldMatrix(true, true);
  const rootBounds = new THREE.Box3().setFromObject(root);
  const rootSize = rootBounds.getSize(new THREE.Vector3());
  const rootCenter = rootBounds.getCenter(new THREE.Vector3());
  const materialIds = new Set<string>();
  const items: ModelReportItem[] = [];
  let objectCount = 0;
  let meshCount = 0;
  let triangleCount = 0;

  root.traverse((object) => {
    objectCount += 1;
    const worldPosition = object.getWorldPosition(new THREE.Vector3());
    const mesh = object as THREE.Mesh;
    let localSize = new THREE.Vector3();
    let triangles = 0;
    let materials: string[] = [];
    let kind: ModelReportItem["kind"] = "object";

    if (mesh.isMesh) {
      kind = "mesh";
      meshCount += 1;
      triangles = meshTriangles(mesh);
      triangleCount += triangles;
      materials = materialNames(mesh.material);
      const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materialList.forEach((material) => materialIds.add(material.uuid));
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) {
        localSize = mesh.geometry.boundingBox
          .clone()
          .applyMatrix4(mesh.matrixWorld)
          .getSize(new THREE.Vector3());
      }
    } else if (object.type === "Group") {
      kind = "group";
    }

    items.push({
      path: objectPath(object),
      name: object.name || object.type,
      kind,
      position: vec3(worldPosition),
      size: vec3(localSize),
      triangleCount: triangles,
      materialNames: materials,
    });
  });

  return {
    modelName,
    fileSize,
    sha256,
    objectCount,
    meshCount,
    materialCount: materialIds.size,
    triangleCount,
    boundsMin: vec3(rootBounds.min),
    boundsMax: vec3(rootBounds.max),
    boundsSize: vec3(rootSize),
    boundsCenter: vec3(rootCenter),
    items,
  };
}

export function cloneSceneWithMaterialOverrides(
  source: THREE.Object3D,
  opacity: number,
): THREE.Object3D {
  const clone = source.clone(true);
  clone.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => {
        const next = material.clone();
        next.transparent = opacity < 0.999 || next.transparent;
        next.opacity = opacity;
        return next;
      });
    } else {
      const next = mesh.material.clone();
      next.transparent = opacity < 0.999 || next.transparent;
      next.opacity = opacity;
      mesh.material = next;
    }
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
  });
  return clone;
}
