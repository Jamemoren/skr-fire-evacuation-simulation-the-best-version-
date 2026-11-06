import * as THREE from "three";
import type { ModelObjectEdit, ModelObjectInfo, Vec3 } from "../types";

interface BaseObject {
  mesh: THREE.Mesh;
  info: ModelObjectInfo;
  colors: Array<THREE.Color | null>;
  visible: boolean;
}
const values = (value: THREE.Vector3 | THREE.Euler): Vec3 => [value.x, value.y, value.z];
const materials = (mesh: THREE.Mesh): THREE.Material[] => Array.isArray(mesh.material) ? mesh.material : [mesh.material];
const colorOf = (material: THREE.Material) => (material as THREE.MeshStandardMaterial).color;

export function prepareEditableModel(scene: THREE.Object3D) {
  const objects = new Map<string, BaseObject>();
  const register = (mesh: THREE.Mesh, id: string) => {
    mesh.userData.editorId = id;
    const colors = materials(mesh).map((material) => colorOf(material)?.clone() ?? null);
    const info: ModelObjectInfo = {
      id, name: mesh.name || "Mesh", position: values(mesh.position), rotation: values(mesh.rotation),
      scale: values(mesh.scale), color: colors[0] ? "#" + colors[0].getHexString() : "#cccccc",
    };
    objects.set(id, { mesh, info, colors, visible: mesh.visible });
  };
  const visit = (node: THREE.Object3D, path: string) => {
    if ((node as THREE.Mesh).isMesh) register(node as THREE.Mesh, path);
    node.children.forEach((child, index) => visit(child, path + "/" + index));
  };
  visit(scene, "model");
  return {
    objects,
    apply(edits: Record<string, ModelObjectEdit>): ModelObjectInfo[] {
      for (const [id, item] of objects) {
        if (id.startsWith("object-") && !edits[id]?.duplicateOf) {
          item.mesh.removeFromParent();
          materials(item.mesh).forEach((material) => material.dispose());
          objects.delete(id);
        }
      }
      for (const [id, edit] of Object.entries(edits)) {
        if (!edit.duplicateOf || objects.has(id)) continue;
        const source = objects.get(edit.duplicateOf);
        if (!source?.mesh.parent) continue;
        const mesh = source.mesh.clone(false);
        mesh.position.fromArray(source.info.position);
        mesh.rotation.set(...source.info.rotation);
        mesh.scale.fromArray(source.info.scale);
        mesh.material = Array.isArray(source.mesh.material)
          ? source.mesh.material.map((material) => material.clone()) : source.mesh.material.clone();
        source.mesh.parent.add(mesh);
        register(mesh, id);
      }
      for (const [id, item] of objects) {
        const edit = edits[id] ?? {};
        item.mesh.name = edit.name ?? item.info.name;
        item.mesh.position.fromArray(edit.position ?? item.info.position);
        item.mesh.rotation.set(...edit.rotation ?? item.info.rotation);
        item.mesh.scale.fromArray(edit.scale ?? item.info.scale);
        item.mesh.visible = !edit.deleted && (edit.visible ?? item.visible);
        materials(item.mesh).forEach((material, index) => {
          const color = colorOf(material);
          if (!color) return;
          if (edit.color) color.set(edit.color);
          else if (item.colors[index]) color.copy(item.colors[index]!);
        });
        item.mesh.updateMatrixWorld(true);
      }
      return [...objects.values()].map((item) => item.info);
    },
  };
}
