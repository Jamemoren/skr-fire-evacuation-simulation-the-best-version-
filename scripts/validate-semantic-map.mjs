import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("วิธีใช้: npm run validate-map -- path/to/school-semantic-map.json");
  process.exit(1);
}

const map = JSON.parse(readFileSync(resolve(input), "utf8"));
const errors = [];
const warnings = [];
if (map.schema !== "skr-semantic-map") errors.push("schema ต้องเป็น skr-semantic-map");
if (map.version !== 2) errors.push("รองรับ version 2");
if (map.coordinateSpace !== "model-local") errors.push("coordinateSpace ต้องเป็น model-local");
if (!map.project?.name) errors.push("ไม่มี project.name");
if (!Array.isArray(map.annotations)) errors.push("annotations ต้องเป็น array");
if (!Array.isArray(map.connections)) errors.push("connections ต้องเป็น array");
if (!map.calibration?.position || !map.calibration?.rotation) errors.push("ไม่มี calibration ที่สมบูรณ์");

const ids = new Set();
for (const annotation of map.annotations ?? []) {
  if (!annotation.id) errors.push("พบ annotation ไม่มี id");
  if (ids.has(annotation.id)) errors.push(`id ซ้ำ: ${annotation.id}`);
  ids.add(annotation.id);
  if (!Array.isArray(annotation.position) || annotation.position.length !== 3) errors.push(`position ผิดรูปแบบ: ${annotation.id}`);
  if (!Array.isArray(annotation.size) || annotation.size.length !== 3) errors.push(`size ผิดรูปแบบ: ${annotation.id}`);
  if (!Array.isArray(annotation.tags)) warnings.push(`tags ไม่ใช่ array: ${annotation.id}`);
  if (typeof annotation.visible !== "boolean") warnings.push(`visible ไม่ใช่ boolean: ${annotation.id}`);
  if (typeof annotation.locked !== "boolean") warnings.push(`locked ไม่ใช่ boolean: ${annotation.id}`);
}
for (const connection of map.connections ?? []) {
  if (!ids.has(connection.fromId)) errors.push(`connection อ้าง fromId ที่ไม่มี: ${connection.fromId}`);
  if (!ids.has(connection.toId)) errors.push(`connection อ้าง toId ที่ไม่มี: ${connection.toId}`);
  if (Number(connection.width) <= 0) errors.push(`connection width ต้องมากกว่า 0: ${connection.id}`);
  if (Number(connection.capacityPerSecond) <= 0) errors.push(`connection capacityPerSecond ต้องมากกว่า 0: ${connection.id}`);
}

if (errors.length) {
  console.error("Semantic Map ไม่ผ่าน:\n" + errors.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

const classrooms = map.annotations.filter((item) => item.type === "classroom");
const people = classrooms.reduce((sum, item) => sum + Number(item.peopleCount || 0), 0);
console.log(`Semantic Map schema version 2 ผ่าน: ${map.annotations.length} ตำแหน่ง, ${map.connections.length} เส้นเชื่อม, ${classrooms.length} ห้องเรียน, ${people} คน`);
if (warnings.length) console.log("คำเตือน:\n" + warnings.map((item) => `- ${item}`).join("\n"));
