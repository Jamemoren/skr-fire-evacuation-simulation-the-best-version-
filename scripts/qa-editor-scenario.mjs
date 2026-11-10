// Model editor → simulation: which edits a run applies, which it refuses, and that the runtime
// really applies them (fires placed, passages closed, people per room) without breaking physics.
//
//   node scripts/qa-editor-scenario.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, Module } from "node:module";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-editor-scenario-"));
process.env.NODE_PATH = resolve(root, "node_modules"); Module._initPaths();
const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };

try {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck",
    "src/simulation/editorScenario.ts", "src/simulation/runtime.ts", "src/simulation/graphEdits.ts", "src/building1/siteLayout.ts"], { cwd: root, stdio: "inherit" });
  const { analyzeEditorMap } = require(join(temp, "simulation/editorScenario.js"));
  const { buildGeneratedSemanticMap } = require(join(temp, "simulation/semanticGraph.js"));
  const { EvacuationRuntime } = require(join(temp, "simulation/runtime.js"));
  const { pointRisk } = require(join(temp, "simulation/graph.js"));
  const base = () => { const map = buildGeneratedSemanticMap(); map.objects = {}; return map; };
  const marker = (map, type, id, name, position, size = [1, 1, 1]) => {
    map.annotations.push({ ...map.annotations[0], id, type, shape: "box", name, position, rotation: [0, 0, 0], size, floor: null, peopleCount: 0, capacity: 0, locked: false, visible: true, tags: [] });
  };

  // 1. standard map
  {
    const a = analyzeEditorMap(base());
    check("E1 the standard map is runnable and applies nothing", a.runnable && a.standard && a.applied.length === 0 && a.blockers.length === 0, a.blockers);
  }
  // 2. scenario edits are applied
  const map = base();
  const corridor = map.annotations.find((node) => node.id === "sim-corr-pink-f5-b3");
  marker(map, "fire-source", "editor-fire-1", "ไฟทดสอบทางเดิน ชั้น 5", [...corridor.position]);
  const stair = map.annotations.find((node) => node.id === "sim-stair-left-f5");
  marker(map, "restricted-area", "editor-noentry-1", "ห้ามใช้บันไดซ้าย ชั้น 5", [...stair.position], [6, 3, 6]);
  const disabled = map.connections.find((edge) => edge.id === "edge-center-stair-door");
  disabled.enabled = false;
  for (const node of map.annotations) if (node.type === "classroom") node.peopleCount = node.id.startsWith("b1-f9-") ? 10 : 0;
  map.annotations.find((node) => node.id === "b1-f9-pink-1").name = "ห้องที่เปลี่ยนชื่อ";
  const analysis = analyzeEditorMap(map);
  const s = analysis.scenario;
  check("E2 fire marker, no-go area, closed passage, people per room and a renamed room are accepted", analysis.runnable && !analysis.standard, analysis.blockers);
  check("E2 the fire marker becomes a fire at the marker", s.fires.length === 1 && s.fires[0].position.join() === corridor.position.join());
  check("E2 the no-go area closes the passages through it (the floor-5 left stair)", s.restricted[0].edgeIds.length > 0 && s.restricted[0].edgeIds.some((id) => id.includes("left")), s.restricted[0].edgeIds.slice(0, 6));
  check("E2 the switched-off passage is closed", s.disabledEdgeIds.includes("edge-center-stair-door"));
  check("E2 people per room: only floor 9 rooms, 10 each", s.roomPopulation && Object.entries(s.roomPopulation).every(([id, n]) => (id.startsWith("b1-f9-") ? n === 10 : n === 0)), s.roomPopulationTotal);
  check("E2 the start screen lists what will be applied", analysis.applied.length === 4, analysis.applied);

  // 3. the runtime applies them
  {
    const rt = new EvacuationRuntime();
    const closures = [...s.disabledEdgeIds, ...s.restricted.flatMap((area) => area.edgeIds)];
    rt.setPassageClosed(closures, true);
    rt.addFire([...s.fires[0].position], { sourceMarkerId: s.fires[0].id });
    rt.start({ populationTarget: 3000, roomPopulation: s.roomPopulation, seed: 31, responseDelayMin: 0, responseDelayMax: 1 });
    check("E3 the run spawns exactly the edited head count", rt.agents.length === s.roomPopulationTotal && rt.agents.every((agent) => agent.roomId.startsWith("b1-f9-")), { agents: rt.agents.length, expected: s.roomPopulationTotal });
    check("E3 the editor fire is in the run and tagged with its marker", rt.fires.length === 1 && rt.fires[0].sourceMarkerId === "editor-fire-1");
    check("E3 the passages are closed in the run", closures.every((id) => rt.closedEdges.has(id)), closures.length);
    let used = 0, inFlame = 0;
    const closedSet = new Set(closures);
    for (let i = 0; i < 6000 && !rt.completed; i += 1) {
      rt.advance(0.1);
      for (const agent of rt.agents) {
        if (agent.edgeEntered && closedSet.has(agent.route.edgeIds[agent.edgeIndex])) used += 1;
        if (pointRisk(agent.position, rt.fires, rt.time).blocked) inFlame += 1;
      }
    }
    const m = rt.getMetrics();
    check("E3 nobody walks a closed passage", used === 0, used);
    check("E3 nobody is counted standing in flame by this check", inFlame === 0, inFlame);
    check("E3 physics stays valid (no topology violation)", m.topologyViolations === 0 && m.stateInconsistencies === 0, { topo: m.topologyViolations, state: m.stateInconsistencies });
    check("E3 the run reports everyone (arrived + incapacitated + still inside = total)", m.arrived + m.incapacitated + rt.agents.filter((a) => a.status !== "arrived" && a.status !== "incapacitated").length === rt.agents.length, `${m.arrived}/${rt.agents.length} arrived`);
  }

  // 4. what the editor may and may not change (2026-11-09: deletions now close passages and new
  //    passages are accepted with physical evidence — the earlier "refused" checks were replaced
  //    because the user asked for the editor to work for real; refusals that remain are below).
  const { applyGraphEdits } = require(join(temp, "simulation/graphEdits.js"));
  const { createEvacuationGraph } = require(join(temp, "simulation/graph.js"));
  // Stand-in for the 3D model: a floor under every point, and optional axis-aligned walls.
  const fakePhysics = (walls = []) => ({
    floorBelow: (p) => p[1] - 0.15,
    obstacle: (a, b) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.05));
      for (let i = 1; i < steps; i += 1) {
        const p = a.map((v, k) => v + (b[k] - v) * i / steps);
        for (const w of walls) if (p[0] >= w.min[0] && p[0] <= w.max[0] && p[1] >= w.min[1] && p[1] <= w.max[1] && p[2] >= w.min[2] && p[2] <= w.max[2]) return { point: p, name: w.name };
      }
      return null;
    },
  });
  const clear = fakePhysics();
  check("E1 the standard map with a physics check is still standard", (() => { const a = analyzeEditorMap(base(), clear); return a.runnable && a.standard; })());
  {
    const moved = base();
    const room = moved.annotations.find((node) => node.id === "b1-f5-pink-3");
    room.position = [room.position[0] + 2, room.position[1], room.position[2]];
    const a = analyzeEditorMap(moved, clear);
    // 2026-11-10: structure (rooms, stairs, exits, assembly areas) can't be moved by the editor; a moved
    // copy no longer blocks the run — the run uses the model and the editor offers to align it.
    check("E4 a moved classroom does not block: the run uses the real room, noted and alignable", a.runnable && a.driftCount === 1 && a.notes.some((line) => line.includes(room.name)), { blockers: a.blockers, notes: a.notes });
  }
  {
    // A saved standard map from older code (the error report of 2026-11-10): right exit at its old point,
    // assembly areas from the previous site layout, stair lines with float noise, bridge under its floor-4 id.
    const { PREVIOUS_SITE_LAYOUT } = require(join(temp, "building1/siteLayout.js"));
    const old = buildGeneratedSemanticMap(true, PREVIOUS_SITE_LAYOUT, true, true);
    const map = base();
    const exit = map.annotations.find((node) => node.id === "sim-exit-right"); exit.position = [11, 0.2, 48];
    for (const node of map.annotations) if (node.type === "assembly-area") { const prev = old.annotations.find((item) => item.id === node.id); if (prev) { node.position = [...prev.position]; node.size = [...prev.size]; } }
    for (const edge of map.connections) if (edge.id.startsWith("edge-stair-left-")) edge.waypoints = (edge.waypoints ?? []).map((p) => p.map((v) => Math.round(v * 1000) / 1000));
    const bridge = map.connections.find((edge) => edge.id === "campus-straight-bridge-level-3");
    Object.assign(bridge, { id: "campus-straight-bridge-level-4", fromId: bridge.fromId.replace("-f3-", "-f4-"), toId: bridge.toId.replace("-f3-", "-f4-") });
    const a = analyzeEditorMap(map, clear);
    check("E9 an older saved standard map can start (no blockers)", a.runnable, a.blockers);
    check("E9 … the bridge under its old id is not closed or treated as a new passage", !a.scenario.disabledEdgeIds.includes("campus-straight-bridge-level-3") && !(a.scenario.graphEdits?.addedEdges ?? []).length, a.scenario.disabledEdgeIds.slice(0, 4));
    check("E9 … float noise on stair lines is not an edit", !a.notes.join(" ").includes("edge-stair-left"), a.notes);
    check("E9 … the moved exit and assembly areas are noted for alignment", a.driftCount >= 7, { drift: a.driftCount, notes: a.notes });
    const { alignToModel } = require(join(temp, "simulation/editorScenario.js"));
    const aligned = alignToModel(map);
    const after = analyzeEditorMap({ ...map, annotations: aligned.annotations, connections: aligned.connections }, clear);
    check("E9 “จัดให้ตรงโมเดลจริง” makes it the standard map again", after.runnable && after.standard && after.driftCount === 0, { changed: aligned.changed, drift: after.driftCount, applied: after.applied, notes: after.notes });
  }
  {
    const removed = base();
    removed.connections = removed.connections.filter((edge) => edge.id !== "edge-center-stair-door");
    const a = analyzeEditorMap(removed);
    check("E4 deleting a standard passage closes it", a.runnable && a.scenario.disabledEdgeIds.includes("edge-center-stair-door") && a.applied.some((line) => line.includes("ลบเส้นทาง")), a.blockers);
  }
  {
    const map = base();
    const door = map.connections.find((edge) => edge.fromId === "b1-f9-pink-1").toId;
    map.annotations = map.annotations.filter((node) => node.id !== door);
    const a = analyzeEditorMap(map);
    const g = createEvacuationGraph();
    const touching = g.edges.filter((edge) => edge.from === door || edge.to === door).map((edge) => edge.id);
    check("E4 deleting a door closes every passage at it", a.runnable && touching.length >= 2 && touching.every((id) => a.scenario.disabledEdgeIds.includes(id)), touching);
    check("E4 … and warns that the room behind it has no way out", a.notes.some((line) => line.startsWith("⚠") && line.includes("1 ห้อง")), a.notes);
  }
  {
    const map = base();
    const removedCount = map.annotations.find((node) => node.id === "b1-f9-pink-2").peopleCount;
    map.annotations = map.annotations.filter((node) => node.id !== "b1-f9-pink-2");
    const a = analyzeEditorMap(map);
    check("E4 deleting a classroom leaves nobody in it", a.runnable && a.scenario.roomPopulation["b1-f9-pink-2"] === 0 && a.scenario.roomPopulationTotal === 3000 - removedCount, { total: a.scenario.roomPopulationTotal, removedCount });
  }
  {
    const map = base();
    map.annotations = map.annotations.filter((node) => node.type !== "assembly-area");
    const a = analyzeEditorMap(map);
    check("E4 deleting every assembly area is refused", !a.runnable && a.blockers.some((line) => line.includes("จุดรวมพล")), a.blockers);
  }
  const corridorEdge = base().connections.find((edge) => edge.id.startsWith("edge-corr") && edge.bidirectional) ?? base().connections.find((edge) => edge.type === "walkway" && edge.bidirectional && !edge.id.includes("stair"));
  {
    const map = base();
    map.connections.find((edge) => edge.id === corridorEdge.id).width = corridorEdge.width + 1;
    const a = analyzeEditorMap(map);
    check("E5 widening a passage is refused (walls are where they are)", !a.runnable && a.blockers.some((line) => line.includes("กว้าง")), a.blockers);
  }
  {
    const map = base();
    const edge = map.connections.find((item) => item.id === corridorEdge.id);
    edge.width = Math.max(0.6, corridorEdge.width / 2); edge.bidirectional = false;
    const a = analyzeEditorMap(map);
    const g = applyGraphEdits(createEvacuationGraph(), a.scenario.graphEdits);
    const simEdge = g.edges.find((item) => item.id === corridorEdge.id);
    check("E5 narrowing and one-way are applied to the run's network", a.runnable && simEdge.width === edge.width && simEdge.twoWay === false && simEdge.capacityPerSecond < createEvacuationGraph().edges.find((item) => item.id === corridorEdge.id).capacityPerSecond, { id: corridorEdge.id, width: simEdge.width, twoWay: simEdge.twoWay });
  }
  {
    // A classroom door point moved 0.4 m along the corridor.
    const map = base();
    const doorId = map.connections.find((edge) => edge.fromId === "b1-f5-pink-2").toId;
    const door = map.annotations.find((node) => node.id === doorId);
    const original = createEvacuationGraph().nodes.find((node) => node.id === doorId).position;
    door.position = [door.position[0] + 0.4, door.position[1], door.position[2]];
    const waiting = analyzeEditorMap(map);
    check("E6 a moved door waits for the 3D model check when there is none", !waiting.runnable && waiting.blockers.some((line) => line.includes("รอให้โมเดล 3 มิติ")), waiting.blockers);
    const a = analyzeEditorMap(map, clear);
    const g = applyGraphEdits(createEvacuationGraph(), a.scenario.graphEdits);
    const moved = g.nodes.find((node) => node.id === doorId).position;
    check("E6 with a clear model check the door moves in the run's network by the same amount", a.runnable && Math.abs(moved[0] - original[0] - 0.4) < 1e-9 && moved[2] === original[2], { original, moved });
    const wall = fakePhysics([{ name: "B1_TEST_WALL", min: [Math.min(original[0], moved[0]) - 3, original[1] - 1, original[2] - 0.05], max: [Math.max(original[0], moved[0]) + 3, original[1] + 3, original[2] + 0.05] }]);
    const blocked = analyzeEditorMap(map, wall);
    check("E6 a wall across the moved door's path refuses it, naming the wall", !blocked.runnable && blocked.blockers.some((line) => line.includes("ชนผนัง") && line.includes("B1_TEST_WALL")), blocked.blockers);
  }
  {
    const added = base();
    added.connections.push({ ...added.connections[0], id: "new-shortcut", fromId: "b1-f9-pink-1", toId: "sim-zone-a", waypoints: [], enabled: true, bidirectional: true, width: 2 });
    const a = analyzeEditorMap(added, clear);
    check("E7 a new passage that jumps between floors is refused (stairs only)", !a.runnable && a.blockers.some((line) => line.includes("ต่างระดับ")), a.blockers);
  }
  {
    const added = base();
    const src = added.annotations.find((node) => node.type === "classroom");
    added.annotations.push({ ...src, id: "new-room", name: "ห้องใหม่", position: [src.position[0], src.position[1], src.position[2] + 1] });
    added.connections.push({ ...added.connections[0], id: "new-room-link", fromId: "new-room", toId: added.connections.find((edge) => edge.fromId === src.id).toId, waypoints: [], enabled: true });
    const a = analyzeEditorMap(added, clear);
    check("E7 a new classroom is refused (rooms must exist in the model)", !a.runnable && a.blockers.some((line) => line.includes("ห้องใหม่")), a.blockers);
  }
  {
    // A new corridor point in the middle of a corridor, with two new passages around a closed one.
    const map = base();
    const g0 = createEvacuationGraph();
    const pick = g0.edges.find((edge) => edge.kind === "corridor" && edge.twoWay && edge.floorFrom === 5 && edge.floorTo === 5 && !(edge.waypoints ?? []).length
      && g0.nodes.find((node) => node.id === edge.from).type === "corridor" && g0.nodes.find((node) => node.id === edge.to).type === "corridor");
    const a0 = g0.nodes.find((node) => node.id === pick.from).position, b0 = g0.nodes.find((node) => node.id === pick.to).position;
    const mid = a0.map((v, k) => (v + b0[k]) / 2);
    const template = map.annotations.find((node) => node.id === pick.from);
    map.annotations.push({ ...template, id: "new-mid", type: "navigation-node", shape: "point", name: "จุดทางเดินใหม่", position: [...mid], size: [1, 1, 1], peopleCount: 0, capacity: 20, locked: false, tags: [] });
    const conn = map.connections.find((edge) => edge.id === pick.id);
    conn.enabled = false;
    map.connections.push({ ...conn, id: "new-half-a", fromId: pick.from, toId: "new-mid", waypoints: [], enabled: true });
    map.connections.push({ ...conn, id: "new-half-b", fromId: "new-mid", toId: pick.to, waypoints: [], enabled: true });
    for (const node of map.annotations) if (node.type === "classroom") node.peopleCount = node.id.startsWith("b1-f5-") ? 40 : 0;
    const a = analyzeEditorMap(map, clear);
    check("E8 a new point and two new passages are accepted with a clear model check", a.runnable && a.scenario.graphEdits.addedNodes.length === 1 && a.scenario.graphEdits.addedEdges.length === 2, a.blockers);
    const rt = new EvacuationRuntime();
    rt.setPassageClosed(a.scenario.disabledEdgeIds, true);
    rt.start({ populationTarget: 3000, roomPopulation: a.scenario.roomPopulation, graphEdits: a.scenario.graphEdits, editorClosedEdgeIds: a.scenario.disabledEdgeIds, seed: 7, responseDelayMin: 0, responseDelayMax: 1 });
    check("E8 the run's network contains them, with the replaced passage closed", rt.edgeMap.has("new-half-a") && rt.edgeMap.has("new-half-b") && rt.nodeMap.has("new-mid") && rt.closedEdges.has(pick.id));
    const usedNew = new Set();
    for (let i = 0; i < 8000 && !rt.completed; i += 1) {
      rt.advance(0.1);
      for (const agent of rt.agents) { const id = agent.route.edgeIds[agent.edgeIndex]; if (id === "new-half-a" || id === "new-half-b") usedNew.add(agent.id); }
    }
    const m = rt.getMetrics();
    check("E8 people walk the new passages", usedNew.size > 0, usedNew.size);
    check("E8 everyone from floor 5 arrives, physics valid", m.arrived === rt.agents.length && m.topologyViolations === 0 && m.stateInconsistencies === 0, { arrived: m.arrived, total: rt.agents.length, topo: m.topologyViolations });
  }
  {
    const nobody = base();
    for (const node of nobody.annotations) if (node.type === "classroom") node.peopleCount = 0;
    const a = analyzeEditorMap(nobody);
    check("E4 zero people everywhere is refused", !a.runnable, a.blockers);
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
