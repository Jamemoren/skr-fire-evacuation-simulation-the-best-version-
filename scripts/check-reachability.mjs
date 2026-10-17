import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const file = process.argv[2] ?? "examples/building1-semantic-map.json";
const map = JSON.parse(readFileSync(resolve(file), "utf8"));
const graph = new Map();
const add = (a, b) => {
  const list = graph.get(a) ?? [];
  list.push(b);
  graph.set(a, list);
};
for (const edge of map.connections ?? []) {
  if (!edge.enabled) continue;
  add(edge.fromId, edge.toId);
  if (edge.bidirectional) add(edge.toId, edge.fromId);
}
const classrooms = (map.annotations ?? []).filter((item) => item.type === "classroom");
const destinations = new Set((map.annotations ?? []).filter((item) => item.type === "football-field" || item.type === "assembly-area").map((item) => item.id));
const unreachable = [];
for (const room of classrooms) {
  const queue = [room.id];
  const seen = new Set(queue);
  let ok = false;
  while (queue.length) {
    const current = queue.shift();
    if (destinations.has(current)) { ok = true; break; }
    for (const next of graph.get(current) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  if (!ok) unreachable.push(room.id);
}
if (unreachable.length) {
  console.error(`Reachability ไม่ผ่าน: ${unreachable.length} ห้องไปไม่ถึงจุดรวมพล`);
  process.exit(1);
}
console.log(`Reachability ผ่าน: ${classrooms.length}/${classrooms.length} ห้องไปถึงจุดรวมพล`);
