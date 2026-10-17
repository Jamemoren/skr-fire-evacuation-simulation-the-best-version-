import { TARGET_POPULATION } from "../constants";
import type {
  MapValidationResult,
  SemanticAnnotation,
  SemanticConnection,
  ValidationIssue,
} from "../types";

function connectedAnnotationIds(
  annotations: SemanticAnnotation[],
  connections: SemanticConnection[],
): Set<string> {
  const targets = annotations
    .filter((annotation) => annotation.type === "football-field" || annotation.type === "assembly-area")
    .map((annotation) => annotation.id);
  const graph = new Map<string, string[]>();
  for (const annotation of annotations) graph.set(annotation.id, []);
  for (const connection of connections) {
    if (!connection.enabled) continue;
    if (!graph.has(connection.fromId) || !graph.has(connection.toId)) continue;
    // Traverse the reverse graph from destinations: if A -> B, then B can reach A in this search.
    graph.get(connection.toId)?.push(connection.fromId);
    if (connection.bidirectional) graph.get(connection.fromId)?.push(connection.toId);
  }
  const visited = new Set<string>();
  const queue = [...targets];
  for (const id of queue) visited.add(id);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const next of graph.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

export function validateSemanticMap(
  annotations: SemanticAnnotation[],
  connections: SemanticConnection[],
): MapValidationResult {
  const issues: ValidationIssue[] = [];
  const classrooms = annotations.filter((annotation) => annotation.type === "classroom");
  const totalPeople = classrooms.reduce((sum, room) => sum + room.peopleCount, 0);
  const reachable = connectedAnnotationIds(annotations, connections);
  const reachableClassrooms = classrooms.filter((room) => reachable.has(room.id)).length;

  const requireType = (type: SemanticAnnotation["type"], title: string, detail: string) => {
    if (!annotations.some((annotation) => annotation.type === type)) {
      issues.push({ id: `missing-${type}`, severity: "error", title, detail });
    }
  };

  requireType("classroom", "ยังไม่มีห้องเรียน", "ปักตำแหน่งห้องเรียนจริงก่อนกระจายประชากร");
  requireType("door", "ยังไม่มีประตู", "ทุกห้องควรมีจุดประตูที่เชื่อมกับทางเดิน");
  requireType("stair", "ยังไม่มีบันได", "ระบุบันไดสำหรับเชื่อมเส้นทางระหว่างชั้น");
  requireType("exit", "ยังไม่มีทางออก", "กำหนดทางออกจากอาคารอย่างน้อยหนึ่งจุด");
  if (!annotations.some((annotation) => annotation.type === "football-field" || annotation.type === "assembly-area")) {
    issues.push({
      id: "missing-destination",
      severity: "error",
      title: "ยังไม่มีปลายทางอพยพ",
      detail: "เพิ่มสนามฟุตบอลหรือจุดรวมพลอย่างน้อยหนึ่งจุด",
    });
  }

  for (const room of classrooms) {
    if (!room.buildingId.trim()) {
      issues.push({
        id: `room-building-${room.id}`,
        severity: "warning",
        title: `${room.name} ยังไม่ระบุอาคาร`,
        detail: "กำหนดรหัสอาคารเพื่อจัดกลุ่มและวิเคราะห์เส้นทาง",
        annotationId: room.id,
      });
    }
    if (room.floor === null) {
      issues.push({
        id: `room-floor-${room.id}`,
        severity: "warning",
        title: `${room.name} ยังไม่ระบุชั้น`,
        detail: "ระบุชั้นเพื่อเชื่อมกับบันไดและทางเดินที่ถูกต้อง",
        annotationId: room.id,
      });
    }
    if (room.peopleCount <= 0 && !room.tags.includes("inactive-target-scenario")) {
      issues.push({
        id: `room-pop-${room.id}`,
        severity: "warning",
        title: `${room.name} ไม่มีจำนวนคน`,
        detail: "กำหนดจำนวนคน หรือใช้ปุ่มกระจาย 3,000 คน",
        annotationId: room.id,
      });
    }
    if (!reachable.has(room.id)) {
      issues.push({
        id: `room-route-${room.id}`,
        severity: "error",
        title: `${room.name} ยังไม่มีเส้นทางถึงจุดรวมพล`,
        detail: "เชื่อมห้อง → ประตู → ทางเดิน → บันได/ทางออก → สนามฟุตบอล",
        annotationId: room.id,
      });
    }
  }

  if (totalPeople !== TARGET_POPULATION) {
    issues.push({
      id: "population-total",
      severity: totalPeople === 0 ? "error" : "warning",
      title: `จำนวนคนรวม ${totalPeople.toLocaleString("th-TH")} คน`,
      detail: `เป้าหมายคือ ${TARGET_POPULATION.toLocaleString("th-TH")} คน ต่างกัน ${Math.abs(TARGET_POPULATION - totalPeople).toLocaleString("th-TH")} คน`,
    });
  }

  const duplicateNames = new Map<string, string[]>();
  for (const annotation of annotations) {
    const key = annotation.name.trim().toLocaleLowerCase("th-TH");
    if (!key) continue;
    duplicateNames.set(key, [...(duplicateNames.get(key) ?? []), annotation.id]);
  }
  for (const [name, ids] of duplicateNames) {
    if (ids.length > 1) {
      issues.push({
        id: `duplicate-${name}`,
        severity: "info",
        title: `ชื่อ “${name}” ซ้ำ ${ids.length} รายการ`,
        detail: "ชื่อซ้ำได้ แต่ควรเพิ่มรหัสอาคารหรือชั้นเพื่อป้องกันความสับสน",
        annotationId: ids[0],
      });
    }
  }

  const annotationIds = new Set(annotations.map((annotation) => annotation.id));
  for (const connection of connections) {
    if (!annotationIds.has(connection.fromId) || !annotationIds.has(connection.toId)) {
      issues.push({
        id: `orphan-connection-${connection.id}`,
        severity: "error",
        title: "พบเส้นเชื่อมที่ไม่มีตำแหน่งต้นทางหรือปลายทาง",
        detail: `Connection ID: ${connection.id}`,
      });
    }
    if (connection.width <= 0 || connection.capacityPerSecond <= 0) {
      issues.push({
        id: `capacity-${connection.id}`,
        severity: "warning",
        title: "เส้นเชื่อมมีความจุไม่ถูกต้อง",
        detail: "ความกว้างและ Capacity ต่อวินาทีต้องมากกว่า 0",
      });
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  let score = 100 - errorCount * 12 - warningCount * 4;
  if (classrooms.length > 0) {
    score += Math.round((reachableClassrooms / classrooms.length) * 10) - 10;
  }
  score = Math.max(0, Math.min(100, score));

  if (issues.length === 0) {
    issues.push({
      id: "complete",
      severity: "success",
      title: "ข้อมูลพื้นฐานครบถ้วน",
      detail: "พร้อมส่งต่อไปสร้าง Navigation Graph และ Simulation ใน Phase ถัดไป",
    });
  }

  return {
    score,
    issues,
    reachableClassrooms,
    totalClassrooms: classrooms.length,
    totalPeople,
  };
}
