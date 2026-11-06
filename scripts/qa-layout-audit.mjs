// Layout/topology audit for Buildings 1, 3, 4, the 3–4 bridge and assembly routes.
// Checks graph integrity and physical rules; REPORTS (does not fix) single points of failure.
// It never adds edges: any missing way out is a finding for the field survey, not something to invent.
//
//   node scripts/qa-layout-audit.mjs            → artifacts/layout-audit/results.json
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, Module } from "node:module";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-layout-"));
process.env.NODE_PATH = resolve(root, "node_modules"); Module._initPaths();
const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };
const building = (id) => id.startsWith("campus-b3") || id.startsWith("b3-") || id.includes("-b3-f") ? 3
  : id.startsWith("campus-b4") || id.startsWith("b4-") || id.includes("-b4-f") ? 4
  : id.startsWith("campus-") ? "site" : 1;

try {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck", "src/simulation/runtime.ts"], { cwd: root, stdio: "inherit" });
  const { createEvacuationGraph, findPath, routeIsPhysicallyValid, traversalPoints } = require(join(temp, "simulation/graph.js"));
  const { pointInsideWalkableCorridor } = require(join(temp, "simulation/walkable.js"));
  const { EvacuationRuntime } = require(join(temp, "simulation/runtime.js"));
  const graph = createEvacuationGraph();
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeMap = new Map(graph.edges.map((e) => [e.id, e]));
  const goals = graph.nodes.filter((n) => n.type === "assembly").map((n) => n.id);
  const config = new EvacuationRuntime().config ?? {};
  const report = { counts: {}, singleDoorRooms: {}, stairs: {}, bridge: {}, deadEnds: [], exitClosure: [], routes: {}, notes: [] };

  // ---- 1. integrity
  check("A1 node ids unique", nodeMap.size === graph.nodes.length, { nodes: graph.nodes.length });
  check("A2 edge ids unique", edgeMap.size === graph.edges.length, { edges: graph.edges.length });
  const badEnds = graph.edges.filter((e) => !nodeMap.has(e.from) || !nodeMap.has(e.to)).map((e) => e.id);
  check("A3 every edge joins two existing nodes", badEnds.length === 0, badEnds.slice(0, 5));
  const badLen = graph.edges.filter((e) => !(Number.isFinite(e.distance) && e.distance > 0) || !(e.width > 0)).map((e) => e.id);
  check("A4 every edge has positive length and width", badLen.length === 0, badLen.slice(0, 5));
  for (const n of graph.nodes) { const k = `${building(n.id)}:${n.type}`; report.counts[k] = (report.counts[k] ?? 0) + 1; }

  // ---- 2. arcs (directed) and walkable geometry of every arc
  const arcs = [];
  for (const e of graph.edges) { arcs.push([e, e.from, e.to]); if (e.twoWay) arcs.push([e, e.to, e.from]); }
  const out = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const [e, a, b] of arcs) out.get(a).push([e, b]);
  let geomBad = [];
  for (const [e, a, b] of arcs) {
    const pts = traversalPoints(e, nodeMap, a, b);
    for (let i = 1; i < pts.length && geomBad.length < 20; i += 1) {
      const steps = Math.max(2, Math.ceil(Math.hypot(...pts[i].map((v, j) => v - pts[i - 1][j])) / 0.45));
      let ok = true;
      for (let s = 0; s <= steps; s += 1) {
        const p = pts[i - 1].map((v, j) => v + (pts[i][j] - v) * s / steps);
        if (!pointInsideWalkableCorridor(p, pts, e)) { ok = false; break; }
      }
      if (!ok) { geomBad.push(`${e.id}:${a}>${b}`); break; }
    }
  }
  check("B1 every walkable arc stays inside its own walkable corridor (0.45 m samples)", geomBad.length === 0, geomBad.slice(0, 8));

  // ---- 3. rooms: leave only through a door portal
  const rooms = graph.nodes.filter((n) => n.type === "room");
  const roomViolations = [];
  for (const r of rooms) {
    const exits = out.get(r.id);
    if (!exits.length || exits.some(([, to]) => nodeMap.get(to)?.type !== "door")) roomViolations.push(r.id);
    if (exits.length === 1) { const b = building(r.id); report.singleDoorRooms[b] = (report.singleDoorRooms[b] ?? 0) + 1; }
  }
  check("C1 every room leaves only through a door node", roomViolations.length === 0, roomViolations.slice(0, 5));
  report.notes.push(`ห้องที่มีประตูออกเพียงบานเดียวในกราฟ: ${JSON.stringify(report.singleDoorRooms)} — ถ้าไฟอยู่หน้าประตูนั้น ห้องนั้นไม่มีทางออกตามกราฟ (ต้องสำรวจจริงว่ามีประตูที่สอง/หน้าต่างหนีไฟหรือไม่)`);

  // ---- 4. stairs: one floor down, one-way; no upward travel anywhere
  const stairEdges = graph.edges.filter((e) => e.kind === "stair");
  const stairBad = stairEdges.filter((e) => e.twoWay || nodeMap.get(e.to).floor !== nodeMap.get(e.from).floor - 1).map((e) => e.id);
  check("D1 every stair edge descends exactly one floor and is one-way (down only)", stairBad.length === 0, { stairEdges: stairEdges.length, bad: stairBad.slice(0, 5) });
  const upward = arcs.filter(([, a, b]) => nodeMap.get(b).floor > nodeMap.get(a).floor).map(([e, a, b]) => `${e.id}:${a}>${b}`);
  check("D2 no walkable arc goes up a floor", upward.length === 0, upward.slice(0, 5));
  const crossFloor = graph.edges.filter((e) => !["stair", "outdoor", "assembly", "exit"].includes(e.kind) && nodeMap.get(e.from).floor !== nodeMap.get(e.to).floor).map((e) => e.id);
  check("D3 only stair/exit/outdoor edges change floor", crossFloor.length === 0, crossFloor.slice(0, 5));
  for (const b of [1, 3, 4]) report.stairs[b] = stairEdges.filter((e) => building(e.id) === b || (b === 1 && !e.id.startsWith("campus-"))).length;

  // ---- 5. bridge
  const bridge = graph.edges.filter((e) => /bridge/.test(e.id));
  report.bridge = bridge.map((e) => ({ id: e.id, from: e.from, to: e.to, twoWay: e.twoWay, width: e.width, length: +e.distance.toFixed(2), floors: [nodeMap.get(e.from).floor, nodeMap.get(e.to).floor] }));
  check("E1 the 3–4 bridge exists, is level, two-way, and joins a Building 3 and a Building 4 gallery", bridge.length === 1
    && bridge[0].twoWay && nodeMap.get(bridge[0].from).floor === nodeMap.get(bridge[0].to).floor
    && new Set([building(bridge[0].from), building(bridge[0].to)]).size === 2, report.bridge);

  // ---- 6. reachability with no fire: every room → an assembly, physically valid
  const noFire = [];
  const viaBridge = [];
  for (const r of rooms) {
    const p = findPath(graph, r.id, goals, config, [], 0, new Map());
    if (!p || !routeIsPhysicallyValid(graph, p, nodeMap, edgeMap)) { noFire.push(r.id); continue; }
    if (p.edgeIds.some((id) => /bridge/.test(id))) viaBridge.push(r.id);
    const b = building(r.id); const goal = p.goalId;
    report.routes[b] ??= {}; report.routes[b][goal] = (report.routes[b][goal] ?? 0) + 1;
  }
  check("F1 with no fire every room has a physically valid route to an assembly area", noFire.length === 0, { rooms: rooms.length, failed: noFire.slice(0, 5) });
  report.notes.push(`ห้องที่เส้นทางสั้นสุด (ไม่มีไฟ) ใช้สะพาน 3–4: ${viaBridge.length} ห้อง — สะพานเป็นทางสำรอง ใช้เมื่อบันไดของตึกตัวเองถูกปิด/มีไฟ`);

  // ---- 7. dead ends: a node you can walk into but never out of (other than assembly)
  const reachesGoal = new Set(goals);
  const inc = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const [, a, b] of arcs) inc.get(b).push(a);
  const queue = [...goals];
  while (queue.length) { const id = queue.pop(); for (const a of inc.get(id)) if (!reachesGoal.has(a)) { reachesGoal.add(a); queue.push(a); } }
  report.deadEnds = graph.nodes.filter((n) => !reachesGoal.has(n.id)).map((n) => n.id);
  check("G1 every node can still reach an assembly area (no dead end in the graph)", report.deadEnds.length === 0, report.deadEnds.slice(0, 8));

  // ---- 8. single exit closed: who loses every way out? (one-way stairs make this matter)
  const exitDoors = graph.edges.filter((e) => /exit-door|stair-door$|-stair-door/.test(e.id) || /campus-b\d-exit-door-/.test(e.id));
  for (const closed of exitDoors) {
    const ok = new Set(goals); const q = [...goals];
    while (q.length) { const id = q.pop(); for (const [e, a, b] of arcs) if (b === id && e.id !== closed.id && !ok.has(a)) { ok.add(a); q.push(a); } }
    const lostRooms = rooms.filter((r) => !ok.has(r.id)).length;
    const lostNodes = graph.nodes.filter((n) => !ok.has(n.id)).map((n) => n.id);
    report.exitClosure.push({ closed: closed.id, lostRooms, lostNodes: lostNodes.length, sample: lostNodes.slice(0, 4) });
  }
  const trapped = report.exitClosure.filter((x) => x.lostNodes > 0);
  report.notes.push(`ปิดทางออกชั้นล่างทีละจุด (${exitDoors.length} จุด): จุดที่ทำให้มีโหนดไปจุดรวมพลไม่ได้ = ${trapped.length} — ส่วนใหญ่คือช่วงล่างสุดของบันไดทางเดียวนั้นเอง (คนที่อยู่ในบันไดแล้วย้อนขึ้นไม่ได้ตามกฎ)`);
  check("H1 closing any single ground exit leaves every ROOM with some way out", report.exitClosure.every((x) => x.lostRooms === 0), trapped.map((x) => `${x.closed}:${x.lostRooms}r/${x.lostNodes}n`).slice(0, 8));

  mkdirSync(join(root, "artifacts/layout-audit"), { recursive: true });
  writeFileSync(join(root, "artifacts/layout-audit/results.json"), JSON.stringify({ results, report }, null, 2));
  console.log(JSON.stringify({ counts: report.counts, singleDoorRooms: report.singleDoorRooms, stairs: report.stairs, routes: report.routes, trappedOnClosure: trapped.map((x) => ({ closed: x.closed, lostNodes: x.lostNodes, sample: x.sample })) }, null, 1));
  for (const n of report.notes) console.log("NOTE " + n);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
