import { ANNOTATION_LABELS, TARGET_POPULATION } from "../constants";
import type {
  Calibration,
  ImportableSemanticMap,
  ModelReport,
  ModelSourceInfo,
  ProjectInfo,
  SemanticAnnotation,
  SemanticConnection,
  SemanticMapFile,
  SemanticMapFileV1,
  SemanticMapFileV2,
} from "../types";
import { worldToModelLocal } from "./coordinates";

interface BuildMapInput {
  project: ProjectInfo;
  model: ModelSourceInfo;
  calibration: Calibration;
  modelReport: ModelReport | null;
  annotations: SemanticAnnotation[];
  connections: SemanticConnection[];
}

export function buildSemanticMap(input: BuildMapInput): SemanticMapFile {
  return {
    schema: "skr-semantic-map",
    version: 2,
    exportedAt: new Date().toISOString(),
    coordinateSpace: "model-local",
    project: input.project,
    model: input.model,
    calibration: input.calibration,
    modelReport: input.modelReport,
    annotations: input.annotations,
    connections: input.connections,
  };
}

function csvCell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function annotationsToCsv(annotations: SemanticAnnotation[]): string {
  const header = [
    "id", "type", "name", "modelLocalX", "modelLocalY", "modelLocalZ",
    "buildingId", "floor", "peopleCount", "capacity", "shape",
    "sizeX", "sizeY", "sizeZ", "visible", "locked", "tags",
    "sourceObjectName", "sourceObjectPath", "notes",
  ];
  const rows = annotations.map((annotation) => [
    annotation.id,
    annotation.type,
    annotation.name,
    annotation.position[0],
    annotation.position[1],
    annotation.position[2],
    annotation.buildingId,
    annotation.floor,
    annotation.peopleCount,
    annotation.capacity,
    annotation.shape,
    annotation.size[0],
    annotation.size[1],
    annotation.size[2],
    annotation.visible,
    annotation.locked,
    annotation.tags.join("|"),
    annotation.sourceObjectName,
    annotation.sourceObjectPath,
    annotation.notes,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function connectionsToCsv(
  connections: SemanticConnection[],
  annotations: SemanticAnnotation[],
): string {
  const names = new Map(annotations.map((annotation) => [annotation.id, annotation.name]));
  const header = [
    "id", "fromId", "fromName", "toId", "toName", "type", "width",
    "capacityPerSecond", "bidirectional", "enabled", "notes",
  ];
  const rows = connections.map((connection) => [
    connection.id,
    connection.fromId,
    names.get(connection.fromId) ?? "",
    connection.toId,
    names.get(connection.toId) ?? "",
    connection.type,
    connection.width,
    connection.capacityPerSecond,
    connection.bidirectional,
    connection.enabled,
    connection.notes,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function buildChatSummary(map: SemanticMapFile): string {
  const classrooms = map.annotations.filter((item) => item.type === "classroom");
  const totalPeople = classrooms.reduce((sum, item) => sum + item.peopleCount, 0);
  const buildings = new Set(map.annotations.map((item) => item.buildingId).filter(Boolean));
  const typeCounts = Object.entries(
    map.annotations.reduce<Record<string, number>>((result, item) => {
      result[item.type] = (result[item.type] ?? 0) + 1;
      return result;
    }, {}),
  )
    .map(([type, count]) => `- ${ANNOTATION_LABELS[type as keyof typeof ANNOTATION_LABELS]}: ${count}`)
    .join("\n");

  return `# สรุปแผนที่เชิงความหมายของอาคาร\n\n` +
    `โครงการ: ${map.project.name}\n` +
    `โรงเรียน: ${map.project.schoolName}\n` +
    `โมเดล: ${map.model.name}\n` +
    `SHA-256: ${map.model.sha256 || "ไม่มี"}\n` +
    `ระบบพิกัด: model-local\n` +
    `ตำแหน่งทั้งหมด: ${map.annotations.length}\n` +
    `เส้นเชื่อมทั้งหมด: ${map.connections.length}\n` +
    `อาคารที่ระบุ: ${buildings.size}\n` +
    `ห้องเรียน: ${classrooms.length}\n` +
    `จำนวนคนในห้องเรียน: ${totalPeople}/${TARGET_POPULATION}\n\n` +
    `## จำนวนตำแหน่งตามประเภท\n${typeCounts || "ยังไม่มีข้อมูล"}\n\n` +
    `## สิ่งที่ต้องใช้ต่อ\n` +
    `ใช้ไฟล์แผนที่เชิงความหมายคู่กับโมเดลอาคารเดิม ` +
    `พิกัด Annotation เป็นพิกัดภายในโมเดล จึงยังตรงกับโมเดลแม้เปลี่ยน Calibration ภายหลัง`;
}

export function isImportableSemanticMap(value: unknown): value is ImportableSemanticMap {
  if (!value || typeof value !== "object") return false;
  const map = value as Partial<ImportableSemanticMap>;
  return (
    map.schema === "skr-semantic-map" &&
    (map.version === 1 || map.version === 2) &&
    Array.isArray(map.annotations) &&
    Array.isArray(map.connections) &&
    Boolean(map.calibration) &&
    Boolean(map.model)
  );
}

function migrateV1(map: SemanticMapFileV1): SemanticMapFileV2 {
  const timestamp = new Date().toISOString();
  return {
    schema: "skr-semantic-map",
    version: 2,
    exportedAt: timestamp,
    coordinateSpace: "model-local",
    project: {
      name: "Imported Semantic Map",
      schoolName: "โรงเรียนสวนกุหลาบวิทยาลัย รังสิต",
      description: "นำเข้าจาก Semantic Mapper v1 และแปลงพิกัดเป็น model-local",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    model: map.model,
    calibration: map.calibration,
    modelReport: map.modelReport,
    annotations: map.annotations.map((annotation) => ({
      ...annotation,
      position: worldToModelLocal(annotation.position, map.calibration),
      tags: [],
      visible: true,
      locked: false,
    })),
    connections: map.connections.map((connection) => ({ ...connection, enabled: true })),
  };
}

export function normalizeImportedMap(map: ImportableSemanticMap): SemanticMapFileV2 {
  if (map.version === 1) return migrateV1(map);
  return {
    ...map,
    annotations: map.annotations.map((annotation) => ({
      ...annotation,
      tags: Array.isArray(annotation.tags) ? annotation.tags : [],
      visible: annotation.visible !== false,
      locked: annotation.locked === true,
    })),
    connections: map.connections.map((connection) => ({
      ...connection,
      enabled: connection.enabled !== false,
    })),
  };
}
