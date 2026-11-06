import { ANNOTATION_LABELS, CONNECTION_LABELS } from "../constants";
import type { Calibration, ModelObjectEdit, SemanticMapFile, Vec3 } from "../types";
import { isImportableSemanticMap, normalizeImportedMap } from "./semantic";

const MAGIC = "SKRPRJ01";
const MAX_MANIFEST = 32 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("รูปแบบข้อมูลโครงการไม่ถูกต้อง");
  return value as Record<string, unknown>;
}
function finite(value: unknown, minimum = -Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error("พบค่าตัวเลขไม่ถูกต้องในไฟล์");
  return value;
}
function vector(value: unknown, minimum = -Infinity): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("พิกัดต้องมี X Y Z ครบสามค่า");
  return value.map((item) => finite(item, minimum)) as Vec3;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("พบชื่อหรือข้อความไม่ถูกต้องในไฟล์");
  return value;
}
export function validateCalibration(value: unknown): Calibration {
  const data = record(value);
  const scale = finite(data.scale, Number.MIN_VALUE);
  return { position: vector(data.position), rotation: vector(data.rotation), scale };
}
export function validateObjects(value: unknown): Record<string, ModelObjectEdit> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(record(value)).map(([id, raw]) => {
    if (!id) throw new Error("วัตถุต้องมี ID");
    const edit = record(raw);
    const result: ModelObjectEdit = {};
    for (const key of ["position", "rotation", "scale"] as const) {
      if (edit[key] !== undefined) result[key] = vector(edit[key], key === "scale" ? 0.00001 : -Infinity);
    }
    for (const key of ["name", "duplicateOf"] as const) {
      if (edit[key] !== undefined) result[key] = text(edit[key]);
      if (key === "duplicateOf" && result.duplicateOf && !/^model(?:\/\d+)*$/.test(result.duplicateOf)) throw new Error("ต้นฉบับของสำเนาวัตถุไม่ถูกต้อง");
    }
    for (const key of ["visible", "locked", "deleted"] as const) {
      if (edit[key] !== undefined) {
        if (typeof edit[key] !== "boolean") throw new Error("สถานะวัตถุไม่ถูกต้อง");
        result[key] = edit[key];
      }
    }
    if (edit.color !== undefined) {
      if (typeof edit.color !== "string" || !/^#[0-9a-f]{6}$/i.test(edit.color)) throw new Error("สีวัตถุไม่ถูกต้อง");
      result.color = edit.color;
    }
    return [id, result];
  }));
}

export function validateMap(value: unknown): SemanticMapFile {
  if (!isImportableSemanticMap(value)) throw new Error("ต้องเป็นแผนที่ skr-semantic-map เวอร์ชัน 1 หรือ 2");
  validateCalibration(value.calibration);
  const map = normalizeImportedMap(value);
  if (map.coordinateSpace !== "model-local") throw new Error("ระบบพิกัดของแผนที่ไม่รองรับ");
  const project = record(map.project);
  for (const key of ["name", "schoolName", "description", "createdAt", "updatedAt"]) text(project[key]);
  const model = record(map.model);
  text(model.name); text(model.sha256); finite(model.size, 0);
  if (!["demo", "generated", "uploaded", "public", "empty"].includes(String(model.source))) throw new Error("ชนิดโมเดลไม่รองรับ");
  const ids = new Set<string>();
  for (const item of map.annotations) {
    text(item.id); text(item.name);
    if (!item.id || ids.has(item.id)) throw new Error("พบ ID ของ node ซ้ำหรือว่าง");
    ids.add(item.id);
    if (!Object.hasOwn(ANNOTATION_LABELS, item.type) || !["point", "box"].includes(item.shape)) throw new Error("ชนิด node ไม่รองรับ");
    vector(item.position); vector(item.rotation); vector(item.size, 0.00001);
    finite(item.peopleCount, 0); finite(item.capacity, 0);
    if (item.floor !== null) finite(item.floor);
    for (const key of ["buildingId", "notes", "sourceObjectName", "sourceObjectPath", "createdAt", "updatedAt"] as const) text(item[key]);
    if (!item.tags.every((tag) => typeof tag === "string")) throw new Error("Tags ต้องเป็นข้อความ");
  }
  const edgeIds = new Set<string>();
  for (const edge of map.connections) {
    text(edge.id); text(edge.notes);
    if (!edge.id || edgeIds.has(edge.id)) throw new Error("พบ ID ของ edge ซ้ำหรือว่าง");
    edgeIds.add(edge.id);
    if (!ids.has(edge.fromId) || !ids.has(edge.toId) || edge.fromId === edge.toId) throw new Error("edge อ้างถึง node ที่ไม่มีอยู่หรือจุดเดียวกัน");
    if (!Object.hasOwn(CONNECTION_LABELS, edge.type)) throw new Error("ชนิด edge ไม่รองรับ");
    finite(edge.width, 0.00001); finite(edge.capacityPerSecond, 0.00001);
    if (typeof edge.bidirectional !== "boolean") throw new Error("ทิศทาง edge ไม่ถูกต้อง");
    if (edge.waypoints !== undefined) {
      if (!Array.isArray(edge.waypoints) || edge.waypoints.length > 1000) throw new Error("จุดเลี้ยวของ edge ไม่ถูกต้อง");
      edge.waypoints.forEach(point=>vector(point));
    }
  }
  if (map.editor !== undefined) {
    const editor = record(map.editor);
    for (const key of ["showGrid", "showLabels", "showModel", "snapEnabled"]) {
      if (typeof editor[key] !== "boolean") throw new Error("การตั้งค่าหน้าจอไม่ถูกต้อง");
    }
    finite(editor.snapSize, 0.001);
    if (finite(editor.modelOpacity, 0.08) > 1) throw new Error("ค่าความโปร่งใสไม่ถูกต้อง");
    if (!Array.isArray(editor.hiddenTypes) || !editor.hiddenTypes.every((item) => typeof item === "string" && Object.hasOwn(ANNOTATION_LABELS, item))) throw new Error("รายการชนิดข้อมูลที่ซ่อนไม่ถูกต้อง");
  }
  const editor = map.editor ? {
    showGrid: map.editor.showGrid, showLabels: map.editor.showLabels, showModel: map.editor.showModel,
    modelOpacity: map.editor.modelOpacity, snapEnabled: map.editor.snapEnabled, snapSize: map.editor.snapSize,
    hiddenTypes: map.editor.hiddenTypes,
  } : undefined;
  return { ...map, editor, objects: validateObjects(map.objects), calibration: validateCalibration(map.calibration), modelReport: null };
}

interface Manifest {
  schema: "skr-portable-project";
  version: 1;
  map: SemanticMapFile;
  asset: { name: string; size: number; sha256: string } | null;
}
export function encodeProject(map: SemanticMapFile, asset: Blob | null): Blob {
  const manifest: Manifest = {
    schema: "skr-portable-project", version: 1, map,
    asset: asset ? { name: map.model.name, size: asset.size, sha256: map.model.sha256 } : null,
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  if (json.length > MAX_MANIFEST) throw new Error("ข้อมูลแผนที่มีขนาดเกิน 32 MB");
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(8, json.length, true);
  return new Blob([header, json, ...(asset ? [asset] : [])], { type: "application/octet-stream" });
}
export async function decodeProject(file: Blob): Promise<{ map: SemanticMapFile; asset: File | null }> {
  const header = await file.slice(0, 12).arrayBuffer();
  if (header.byteLength !== 12 || new TextDecoder().decode(new Uint8Array(header, 0, 8)) !== MAGIC) throw new Error("ไฟล์โปรเจกต์ไม่ถูกต้อง");
  const length = new DataView(header).getUint32(8, true);
  if (length > MAX_MANIFEST || length < 2 || 12 + length > file.size) throw new Error("ส่วนข้อมูลโปรเจกต์ไม่ครบหรือใหญ่เกินกำหนด");
  const data = record(JSON.parse(await file.slice(12, 12 + length).text()));
  if (data.schema !== "skr-portable-project" || data.version !== 1) throw new Error("เวอร์ชันโปรเจกต์ไม่รองรับ");
  const map = validateMap(data.map);
  const body = file.slice(12 + length);
  if (data.asset === null) {
    if (body.size || map.model.source === "uploaded" || map.model.source === "public") throw new Error("ไฟล์โปรเจกต์ขาดโมเดล GLB");
    return { map, asset: null };
  }
  const metadata = record(data.asset);
  if (text(metadata.name) !== map.model.name || finite(metadata.size, 0) !== body.size || text(metadata.sha256) !== map.model.sha256) throw new Error("ข้อมูลโมเดลในโปรเจกต์ไม่ตรงกัน");
  return { map, asset: new File([body], map.model.name, { type: "model/gltf-binary" }) };
}
