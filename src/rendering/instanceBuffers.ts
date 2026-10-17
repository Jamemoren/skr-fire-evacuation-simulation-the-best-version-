import { DynamicDrawUsage, type InstancedMesh } from "three";

/** Upload only the live prefix; unused instance capacity never needs to reach the GPU. */
export function uploadInstanceRange(mesh: InstancedMesh, count: number): number {
  mesh.count = count;
  const buffer = mesh.instanceMatrix;
  buffer.setUsage(DynamicDrawUsage);
  buffer.clearUpdateRanges();
  if (count === 0) return 0;
  buffer.addUpdateRange(0, count * 16);
  buffer.needsUpdate = true;
  return count * 16 * buffer.array.BYTES_PER_ELEMENT;
}
