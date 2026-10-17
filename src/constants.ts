import type { AnnotationType, ConnectionType } from "./types";

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  building: "อาคาร",
  floor: "ชั้น",
  classroom: "ห้องเรียน",
  door: "ประตู",
  stair: "บันได",
  exit: "ทางออก",
  hallway: "ทางเดิน",
  "navigation-node": "จุดนำทาง",
  "assembly-area": "จุดรวมพล",
  "football-field": "สนามฟุตบอล",
  "restricted-area": "พื้นที่ห้ามผ่าน",
  "fire-source": "จุดจำลองไฟ",
  custom: "กำหนดเอง",
};

export const ANNOTATION_ICONS: Record<AnnotationType, string> = {
  building: "🏫",
  floor: "🏢",
  classroom: "🚪",
  door: "▣",
  stair: "🪜",
  exit: "↗",
  hallway: "〰",
  "navigation-node": "◆",
  "assembly-area": "◎",
  "football-field": "⚽",
  "restricted-area": "⛔",
  "fire-source": "🔥",
  custom: "📍",
};

export const ANNOTATION_COLORS: Record<AnnotationType, string> = {
  building: "#7c91ff",
  floor: "#9d8cff",
  classroom: "#38bdf8",
  door: "#f5c451",
  stair: "#f59e0b",
  exit: "#4ade80",
  hallway: "#60a5fa",
  "navigation-node": "#22d3ee",
  "assembly-area": "#34d399",
  "football-field": "#16a34a",
  "restricted-area": "#a1a1aa",
  "fire-source": "#ef4444",
  custom: "#e879f9",
};

export const CONNECTION_LABELS: Record<ConnectionType, string> = {
  walkway: "ทางเดิน",
  doorway: "ทางผ่านประตู",
  stair: "ทางบันได",
  "outdoor-path": "ทางเดินภายนอก",
  custom: "กำหนดเอง",
};

export const DEFAULT_MODEL_PATH =
  "/models/suankularb_wittayalai_nonthaburi_school.glb";

export const TARGET_POPULATION = 3000;
export const DEFAULT_PEOPLE_PER_ROOM = 40;
export const STORAGE_KEY = "skr-building1-evacuation-state";
