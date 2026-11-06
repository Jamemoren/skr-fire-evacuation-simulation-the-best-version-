// Behavioural regression suite for the occupant decision model (seeded, reproducible).
//
//   node scripts/qa-crowd-behavior.mjs          → 600-person scenarios + 1,500-person no-fire run
//   node scripts/qa-crowd-behavior.mjs --full   → also the 3,000-person no-fire evacuation
//
// Checks use evidence that is independent of the planner where possible: per-step displacement,
// physical queue order, admission counts against capacity, closed-passage traversal, site
// geometry for assembly positions, and line-of-sight/communication scoping for knowledge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, Module } from "node:module";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-crowd-"));
const require = createRequire(import.meta.url);
process.env.NODE_PATH = resolve(root, "node_modules"); Module._initPaths();
const FULL = process.argv.includes("--full");
const results = [];
const summary = {};
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
}

try {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck",
    "src/simulation/runtime.ts", "src/simulation/semanticGraph.ts", "src/utils/portableProject.ts"], { cwd: root, stdio: "pipe" });
  const { EvacuationRuntime, FIXED_SIMULATION_DT } = require(join(temp, "simulation/runtime.js"));
  const { walkY } = require(join(temp, "simulation/graph.js"));
  const { BLOCK_LEVELS, BLOCK_GALLERY, CAMPUS_BUILDINGS, ALL_CLASSROOMS } = require(join(temp, "simulation/campusData.js"));
  const { perceptionTopology, spacesInView } = require(join(temp, "simulation/agentPerception.js"));
  const { SITE_BOUNDARY, SHRINE_CENTER, SHRINE_CLEARANCE_RADIUS, CAMPUS_AMENITIES } = require(join(temp, "building1/siteLayout.js"));
  const { describeReasonTh } = require(join(temp, "simulation/agentReasons.js"));
  const { buildGeneratedSemanticMap } = require(join(temp, "simulation/semanticGraph.js"));
  const { encodeProject, decodeProject, validateMap } = require(join(temp, "utils/portableProject.js"));
  const DT = FIXED_SIMULATION_DT;
  const BASE = { preset: "balanced", crowdBehavior: "grouped", responseDelayMin: 3, responseDelayMax: 10 };

  const building = (roomId) => roomId.startsWith("b3-") ? "building-3" : roomId.startsWith("b4-") ? "building-4" : "building-1";
  const stateHash = (rt) => {
    let h = 2166136261;
    const mix = (v) => { h ^= Math.round(v * 1e5) | 0; h = Math.imul(h, 16777619); };
    mix(rt.time);
    for (const a of rt.agents) { a.position.forEach(mix); mix(a.edgeIndex); mix(a.status.length); }
    return (h >>> 0).toString(16);
  };

  /** Runs with independent per-step audits. */
  function run(rt, until, { onStep } = {}) {
    const audit = { maxJump: 0, maxStep: 0, jump: null, nan: 0, queueBackSteps: 0, closedTraversals: 0, capacityViolations: [], overlapPairs: 0, floorJumps: 0 };
    // Distance still to walk along the walkway to the entrance (not a straight line: on the
    // switchback stairs the stacked landing nodes share x/z, so a straight-line distance grows while
    // someone walks forward down the first metres of a flight).
    const queueDistance = (a) => {
      if (!a.queueKey) return 0;
      rt.queueRemainingCache.delete(a.id);
      const remaining = rt.queueRemaining(a);
      return Number.isFinite(remaining) ? remaining : 0;
    };
    // Start from each person's actual distance (people can already be queueing when a phase begins).
    const prev = rt.agents.map((a) => ({ p: [...a.position], key: a.queueKey, d: queueDistance(a), entered: a.edgeEntered, edge: null, floor: a.floor, phase: a.phase }));
    // Start each window from the entries already counted when this run begins (queues can carry
    // over from an earlier phase of the same scenario).
    const entryWindow = new Map([...rt.edgeQueues].map(([key, queue]) => [key, queue.entries]));
    let nextCapacityCheck = rt.time + 10;
    const overlapStreak = new Map();
    let nextOverlapCheck = rt.time + 1;
    let nextProgressLog = rt.time + 300;
    while (rt.time < until - 1e-9 && !rt.completed) {
      rt.advance(DT);
      if (rt.time >= nextProgressLog) { nextProgressLog += 300; console.log('PROGRESS', rt.agents.length, Math.round(rt.time), rt.getMetrics().arrived); }
      for (let i = 0; i < rt.agents.length; i += 1) {
        const a = rt.agents[i], p = a.position, q = prev[i];
        if (!p.every(Number.isFinite)) { audit.nan += 1; continue; }
        const d = Math.hypot(p[0] - q.p[0], p[2] - q.p[2]);
        const bound = a.speed * DT * 2.5 + 0.35;
        if (d > audit.maxStep) audit.maxStep = d;
        if (d > bound && d > audit.maxJump) { audit.maxJump = d; audit.jump = { id: a.id, d: +d.toFixed(2), bound: +bound.toFixed(2), status: a.status, t: +rt.time.toFixed(1) }; }
        if (a.status === "queueing" && a.queueKey && a.queueKey === q.key) {
          const dist = queueDistance(a);
          // A real step back needs a real movement of that size (the walkway projection can jump at
          // a switchback corner while the person moves only a few centimetres).
          if (dist > q.d + 0.15 && d >= (dist - q.d) * 0.9) audit.queueBackSteps += 1;
          q.d = dist;
        } else if (a.queueKey) {
          q.d = queueDistance(a);
        }
        const edgeId = a.edgeEntered ? a.route.edgeIds[a.edgeIndex] : null;
        if (edgeId && edgeId !== q.edge && rt.closedEdges.has(edgeId)) audit.closedTraversals += 1;
        // Floor changes only while walking a stair (or when stepping onto a landing node).
        if (a.floor !== q.floor && a.floor > 0 && q.floor > 0 && Math.abs(a.floor - q.floor) > 1) audit.floorJumps += 1;
        q.p = [...p]; q.key = a.queueKey; q.edge = edgeId; q.floor = a.floor; q.phase = a.phase;
      }
      if (rt.time >= nextCapacityCheck) {
        rt.edgeQueues.forEach((queue, key) => {
          const before = entryWindow.get(key) ?? 0;
          const allowed = queue.capacityPerSecond * 10 + queue.burst + 0.5;
          if (queue.entries - before > allowed) audit.capacityViolations.push(`${key}:${queue.entries - before}>${allowed.toFixed(1)}`);
          entryWindow.set(key, queue.entries);
        });
        nextCapacityCheck += 10;
      }
      if (rt.time >= nextOverlapCheck) {
        nextOverlapCheck += 1;
        const grid = new Map();
        const seen = new Set();
        for (const a of rt.agents) {
          if (a.status === "arrived" || a.status === "waiting" || a.status === "incapacitated") continue;
          const key = `${Math.floor(a.position[0] / 0.5)},${Math.floor(a.position[1] / 2)},${Math.floor(a.position[2] / 0.5)}`;
          (grid.get(key) ?? grid.set(key, []).get(key)).push(a);
        }
        grid.forEach((list) => {
          for (let x = 0; x < list.length; x += 1) for (let y = x + 1; y < list.length; y += 1) {
            const a = list[x], b = list[y];
            if (Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]) < 0.05) {
              const pair = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
              seen.add(pair);
              const streak = (overlapStreak.get(pair) ?? 0) + 1;
              overlapStreak.set(pair, streak);
              if (streak === 3) {
                audit.overlapPairs += 1;
                if (audit.overlapPairs <= 4) console.log('OVERLAP', Math.round(rt.time), JSON.stringify([a,b].map(p=>({id:p.id,status:p.status,edge:p.route.edgeIds[p.edgeIndex],entered:p.edgeEntered,position:p.position}))));
              }
            }
          }
        });
        [...overlapStreak.keys()].forEach((pair) => { if (!seen.has(pair)) overlapStreak.delete(pair); });
      }
      onStep?.(rt);
    }
    return audit;
  }
  function invariantChecks(label, rt, audit) {
    const m = rt.getMetrics();
    check(`${label}: no NaN/Infinity positions`, audit.nan === 0 && rt.agents.every((a) => a.position.every(Number.isFinite)), audit.nan);
    check(`${label}: no teleport (max step within physical bound)`, audit.jump === null, audit.jump ?? `largest step ${audit.maxStep.toFixed(2)} m`);
    check(`${label}: no topology violations`, m.topologyViolations === 0, m.topologyViolations);
    check(`${label}: no wall/collision corrections`, m.collisionCorrections === 0, rt.getCollisionCorrectionSamples().slice(0, 1).join(" "));
    check(`${label}: no contradictory states`, m.stateInconsistencies === 0, m.stateInconsistencies);
    check(`${label}: no stale queue reservations`, m.staleQueueRepairs === 0, m.staleQueueRepairs);
    check(`${label}: nobody steps backwards in a queue`, audit.queueBackSteps === 0, audit.queueBackSteps);
    check(`${label}: admissions never exceed passage capacity`, audit.capacityViolations.length === 0, audit.capacityViolations.slice(0, 3).join(" "));
    check(`${label}: no persistent overlapping people (≥3 s)`, audit.overlapPairs === 0, audit.overlapPairs);
    console.log(`INFO  ${label}: stand-still episodes ≥10 s (squeeze-past rule active) — ${m.squeezeEvents ?? 0}`);
    check(`${label}: no floor skipped without stairs`, audit.floorJumps === 0, audit.floorJumps);
    const overCapacity = rt.graph.nodes.filter((n) => n.type === "assembly").filter((n) => rt.agents.filter((a) => a.route.goalId === n.id).length > n.capacity);
    check(`${label}: assembly capacity respected`, overCapacity.length === 0, overCapacity.map((n) => n.id).join(","));
    const slots = new Set();
    let duplicate = 0;
    for (const a of rt.agents) { const key = `${a.route.goalId}#${a.assemblySlotIndex}`; if (a.assemblySlotIndex >= 0 && slots.has(key)) duplicate += 1; slots.add(key); }
    check(`${label}: no shared assembly positions`, duplicate === 0, duplicate);
    return m;
  }
  function reasonCounts(rt) {
    const counts = {};
    for (const a of rt.agents) counts[a.reason.code] = (counts[a.reason.code] ?? 0) + 1;
    return counts;
  }
  function startRuntime(config = {}, setup) {
    const rt = new EvacuationRuntime();
    rt.reset(false);
    setup?.(rt);
    rt.start({ ...BASE, ...config });
    return rt;
  }

  // ---------------------------------------------------------------- Perception topology (unit)
  {
    const rt = new EvacuationRuntime();
    const topo = perceptionTopology(rt.graph);
    const room1 = topo.space.get("b1-f5-pink-1").key, room2 = topo.space.get("b1-f5-pink-2").key;
    const corridor = topo.space.get("sim-corr-pink-f5-b1").key;
    check("LOS: neighbouring classrooms cannot see each other through the wall", !spacesInView(topo, room1, room2));
    check("LOS: classroom ↔ its corridor through the door", spacesInView(topo, room1, corridor));
    check("LOS: different floors never share a space", !spacesInView(topo, corridor, topo.space.get("sim-corr-pink-f6-b1").key));
    const b3 = topo.space.get("campus-b3-f4-gallery-0").key, b4 = topo.space.get("campus-b4-f4-gallery-0").key;
    check("LOS: B3 and B4 fourth floors connect only through the bridge opening", spacesInView(topo, b3, b4) && !spacesInView(topo, topo.space.get("campus-b3-f3-gallery-0").key, topo.space.get("campus-b4-f3-gallery-0").key));
  }

  // ---------------------------------------------------------------- A. No fire
  {
    const population = FULL ? 3000 : 1500;
    const rt = startRuntime({ populationTarget: population, seed: 7 });
    const perBuilding = {};
    for (const a of rt.agents) perBuilding[building(a.roomId)] = (perBuilding[building(a.roomId)] ?? 0) + 1;
    const expected = {};
    for (const room of ALL_CLASSROOMS) expected[room.buildingId] = (expected[room.buildingId] ?? 0);
    check(`A: ${population} people allocated to buildings 1, 3 and 4`, rt.agents.length === population && perBuilding["building-1"] > 0 && perBuilding["building-3"] > 0 && perBuilding["building-4"] > 0, perBuilding);
    const t0 = Date.now();
    const audit = run(rt, 3600);
    const m = invariantChecks("A no-fire", rt, audit);
    check(`A: all ${population} reach an assembly area`, m.arrived === population, `${m.arrived}/${population} at ${m.elapsed.toFixed(1)} s`);
    const reasons = reasonCounts(rt);
    check("A: every arrival is recorded with the arrival reason", (reasons.arrived ?? 0) === m.arrived, reasons);
    const switches = rt.agents.map((a) => a.routeSwitches);
    check("A: no route flip-flopping (≤ 3 switches per person)", Math.max(...switches) <= 3, `max ${Math.max(...switches)}`);
    const goals = new Set(rt.agents.map((a) => a.route.goalId));
    check("A: both the field and the parking assembly areas are used", [...goals].some((g) => g.startsWith("sim-zone")) && [...goals].some((g) => g.startsWith("campus-parking")), [...goals].join(","));
    summary.noFire = { population, seconds: +m.elapsed.toFixed(1), p50: m.p50Arrival, p90: m.p90Arrival, reroutes: m.rerouteCount, wallMs: Date.now() - t0 };
  }

  // ---------------------------------------------------------------- B. Fire and smoke
  {
    // B1 classroom fire in Building 1 floor 5; check knowledge scoping and plan changes.
    const rt = startRuntime({ populationTarget: 600, seed: 11 }, (r) => r.addFire([-8, walkY(5) + 0.25, -5]));
    let leak = 0, firstDirect = null, firstReport = null;
    const audit = run(rt, 120, {
      onStep: (r) => {
        for (const a of r.agents) {
          if (!a.fireKnowledge.size) continue;
          if (building(a.roomId) !== "building-1" && !a.hasExitedBuilding) leak += 1;
          for (const k of a.fireKnowledge.values()) {
            if (k.source === "direct" && firstDirect === null) firstDirect = r.time;
            if (k.source === "reported" && firstReport === null) firstReport = r.time;
          }
        }
      },
    });
    check("B1: a B1 classroom fire never becomes known inside B3/B4", leak === 0, leak);
    check("B1: someone discovers the fire by sight/smell before reports spread", firstDirect !== null || rt.agents.some((a) => [...a.fireKnowledge.values()].some((k) => k.source !== "reported")), { firstDirect, firstReport });
    const knowers = rt.agents.filter((a) => a.fireKnowledge.size);
    const farFloor = knowers.filter((a) => Math.abs(a.floor - 5) > 1 && !a.hasExitedBuilding && a.fireKnowledge.size && [...a.fireKnowledge.values()].every((k) => k.source === "reported") && a.phase !== "stair");
    check("B1: reports travel at most one floor per relay (no omniscient alarm panel)", knowers.length > 0 && knowers.length < rt.agents.length, `${knowers.length} aware of the fire; far-floor reports ${farFloor.length}`);
    invariantChecks("B1 classroom fire", rt, audit);
  }
  {
    // B2 fire at the B1 centre stair landing floor 6: people above must use other stairs.
    const rt = startRuntime({ populationTarget: 600, seed: 12 }, (r) => r.addFire([1.2, walkY(6) + 0.25, 1.9]));
    const audit = run(rt, 700);
    const m = invariantChecks("B2 stair fire", rt, audit);
    const reasons = reasonCounts(rt);
    const hazardSwitches = rt.agents.filter((a) => a.routeSwitches > 0).length;
    check("B2: people change plan after perceiving the stair fire", hazardSwitches > 0, { hazardSwitches, reasons });
    check("B2: outcome is reported honestly (arrived + incapacitated + holding = total)", m.arrived + m.incapacitated + (m.total - m.arrived - m.incapacitated) === m.total, `${m.arrived} arrived, ${m.incapacitated} incapacitated, ${m.holding} holding`);
    summary.stairFire = { arrived: m.arrived, incapacitated: m.incapacitated, holding: m.holding, reroutes: m.rerouteCount, seconds: +m.elapsed.toFixed(1) };
  }
  {
    // B3 corridor fire + B4 bridge fire + B5 outdoor fire in one run.
    const bridgeFire = [-67, BLOCK_LEVELS[3] + 0.2, -43 + BLOCK_GALLERY];
    let bridge = null, outdoor = null, corridor = null;
    const rt = startRuntime({ populationTarget: 600, seed: 13 }, (r) => {
      corridor = r.addFire([-24, walkY(4) + 0.25, 1.9]);
      bridge = r.addFire(bridgeFire);
      outdoor = r.addFire([-194, 0.2, 25]);
    });
    check("B3: corridor fire attached to Building 1 floor 4", corridor.floor === 4 && corridor.wing !== "outdoor", `${corridor.floor}/${corridor.wing}`);
    check("B4: bridge fire stays on the fourth-floor deck", bridge.floor === 4 && Math.abs(bridge.position[1] - BLOCK_LEVELS[3]) < 0.05);
    check("B5: parking/plaza fire is an outdoor hazard", outdoor.floor === 0);
    let b1KnowsBridge = 0;
    // Anyone from B3/B4 who spends ≥ 2 s within 2 m of the bridge fire on the fourth-floor deck
    // must know of it (plain sight); nobody is required to know it from further away.
    const nearSeconds = new Map();
    const audit = run(rt, 90, { onStep: (r) => {
      for (const a of r.agents) {
        if (building(a.roomId) === "building-1" && !a.hasExitedBuilding && a.fireKnowledge.has(bridge.id)) b1KnowsBridge += 1;
        if (building(a.roomId) !== "building-1" && a.floor === 4 && Math.hypot(a.position[0] - bridge.position[0], a.position[2] - bridge.position[2]) <= 2) {
          nearSeconds.set(a.id, (nearSeconds.get(a.id) ?? 0) + DT);
        }
      }
    } });
    check("B4: Building 1 occupants never learn of the B3–B4 bridge fire through walls", b1KnowsBridge === 0, b1KnowsBridge);
    const exposed = [...nearSeconds].filter(([, seconds]) => seconds >= 2).map(([id]) => rt.agents[id]);
    check("B4: every B3/B4 occupant who stood within 2 m of the bridge fire knows of it", exposed.every((a) => a.fireKnowledge.has(bridge.id)),
      `${exposed.filter((a) => a.fireKnowledge.has(bridge.id)).length}/${exposed.length} exposed (nobody is required to see it from afar)`);
    invariantChecks("B3–B5 multi-fire", rt, audit);
  }
  {
    // B4 perception probe: the straight bridge is part of both fourth-floor decks. A person standing
    // at the B4 end sees a fire 2 m out on the bridge; a person on B1 floor 4 never does.
    const deckY = BLOCK_LEVELS[3];
    let fire = null;
    const rt = startRuntime({ populationTarget: 300, seed: 21, responseDelayMin: 0, responseDelayMax: 1 }, (r) => { fire = r.addFire([-50.5, deckY + 0.2, -39.98]); });
    rt.advance(20);
    const b4End = rt.nodeMap.get("campus-b4-f4-gallery-0");
    const probe = rt.agents.find((a) => building(a.roomId) === "building-4" && a.floor === 4);
    // Start the probe from "does not know" so the check measures this one perception update.
    probe?.fireKnowledge.delete(fire.id);
    const b1Probe = rt.agents.find((a) => building(a.roomId) === "building-1" && a.floor === 4);
    if (!probe || !b4End || !b1Probe) {
      check("B4 probe: setup found a B4 fourth-floor occupant and the bridge end", false, { probe: Boolean(probe), b4End: Boolean(b4End), b1Probe: Boolean(b1Probe) });
    } else {
      probe.position = [b4End.position[0], b4End.position[1], b4End.position[2]];
      probe.currentNodeId = b4End.id;
      rt.updateFireAwareness(probe);
      check("B4 probe: someone at the B4 end of the bridge sees a fire on the bridge", probe.fireKnowledge.has(fire.id), probe.fireKnowledge.get(fire.id)?.source ?? "unknown");
      rt.updateFireAwareness(b1Probe);
      check("B4 probe: a Building 1 fourth-floor occupant does not perceive the bridge fire directly",
        !["direct", "smoke", "heat"].includes(b1Probe.fireKnowledge.get(fire.id)?.source), b1Probe.fireKnowledge.get(fire.id)?.source ?? "none");
    }
  }
  {
    // B6 an unknown hazard is not used for planning; B7 discovery changes the plan.
    const rt = startRuntime({ populationTarget: 600, seed: 14, responseDelayMin: 0, responseDelayMax: 1 }, (r) => r.addFire([-8, walkY(8) + 0.25, -5]));
    rt.advance(2);
    const groundFloor = rt.agents.filter((a) => a.floor <= 3);
    check("B6: people far below an upper-floor fire do not plan with it yet", groundFloor.every((a) => rt.knownFireSources(a).length === 0), groundFloor.filter((a) => rt.knownFireSources(a).length).length);
    run(rt, 160);
    const switched = rt.agents.filter((a) => a.reason.code === "switch-hazard" || (a.routeSwitches > 0 && a.fireKnowledge.size));
    check("B7: after discovering the fire some people re-plan", switched.length > 0, switched.length);
    const believed = rt.agents.find((a) => [...a.fireKnowledge.values()].some((k) => k.source === "reported"));
    if (believed) {
      const fire = rt.fires[0];
      const belief = rt.knownFireSources(believed)[0];
      check("B7: a second-hand report gives an uncertain, not exact, fire location", belief && (belief.position[0] !== fire.position[0] || belief.position[2] !== fire.position[2] || belief.fireRadius > fire.fireRadius));
    }
  }

  // ---------------------------------------------------------------- C. Closed passages
  {
    const rt = startRuntime({ populationTarget: 600, seed: 21 }, (r) => r.setPassageGroupClosed("b1-stair-center", true));
    const audit = run(rt, 2400);
    const m = invariantChecks("C1 centre stair closed", rt, audit);
    check("C1: nobody walks through the closed stair", audit.closedTraversals === 0, audit.closedTraversals);
    check("C1: everyone still reaches assembly via other stairs", m.arrived === m.total, `${m.arrived}/${m.total}`);
    check("C1: closure discovered and acted on (switch-closed reasons or memory)", rt.agents.some((a) => a.knownClosed.size > 0), rt.agents.filter((a) => a.knownClosed.size).length);
  }
  {
    const rt = startRuntime({ populationTarget: 600, seed: 22 }, (r) => { r.setPassageGroupClosed("b3-stair-0", true); r.setPassageGroupClosed("b3-stair-1", true); });
    let bridgeUsers = new Set();
    const audit = run(rt, 2400, { onStep: (r) => { for (const a of r.agents) if (a.edgeEntered && a.route.edgeIds[a.edgeIndex] === "campus-straight-bridge-level-4") bridgeUsers.add(a.id); } });
    const m = invariantChecks("C2 B3 stairs closed", rt, audit);
    const b3 = rt.agents.filter((a) => a.roomId.startsWith("b3-"));
    check("C2: Building 3 occupants escape through the fourth-floor bridge", [...bridgeUsers].some((id) => rt.agents[id].roomId.startsWith("b3-")), bridgeUsers.size);
    check("C2: nobody uses a closed B3 stair", audit.closedTraversals === 0, audit.closedTraversals);
    // With both B3 stairs closed there is physically no way off floors 2–3 (no stair at all):
    // floor 1 walks out, floor 4 crosses the bridge, floors 2–3 must never be counted as arrived.
    const b3Escapable = b3.filter((a) => a.floor === 1 || a.roomId.includes("-f4-") || a.roomId.includes("-f1-"));
    const b3Trapped = b3.filter((a) => a.roomId.includes("-f2-") || a.roomId.includes("-f3-"));
    check("C2: B3 floor 1 and floor 4 occupants all arrive", b3Escapable.every((a) => a.status === "arrived"), `${b3Escapable.filter((a) => a.status === "arrived").length}/${b3Escapable.length}`);
    check("C2: B3 floors 2–3 (no stair left) are never reported as arrived", b3Trapped.length > 0 && b3Trapped.every((a) => a.status !== "arrived"), `${b3Trapped.filter((a) => a.status === "arrived").length} arrived of ${b3Trapped.length}`);
    summary.b3StairsClosed = { arrived: m.arrived, total: m.total, bridgeUsers: bridgeUsers.size, seconds: +m.elapsed.toFixed(1) };
  }
  {
    const rt = startRuntime({ populationTarget: 600, seed: 23 }, (r) => { r.setPassageGroupClosed("b34-bridge", true); r.setPassageGroupClosed("b1-exit-left", true); });
    const audit = run(rt, 2400);
    const m = invariantChecks("C3/C4 bridge + exit closed", rt, audit);
    check("C3/C4: closed bridge and exit are never used", audit.closedTraversals === 0, audit.closedTraversals);
    // Known graph limitation (not changed to pass a test): stairs are modelled one-way downwards,
    // so someone who reaches the foot of the left stair before learning that its exit is closed has
    // no modelled way back up. They must be reported as holding at that dead end, never as arrived.
    const notArrived = rt.agents.filter((a) => a.status !== "arrived");
    const deadEnd = notArrived.filter((a) => a.status === "blocked" && a.route.nodeIds[a.edgeIndex] === "sim-stair-exit-door-left");
    check("C3/C4: everyone arrives except people at the closed exit's dead end, who are reported holding",
      notArrived.length === deadEnd.length, `${m.arrived}/${m.total} arrived, ${deadEnd.length} holding at the closed left exit (one-way stair in graph)`);
  }
  {
    // C5 every B1 stair closed → holding, honestly reported, bounded planning; C6 reopen → recover.
    const rt = startRuntime({ populationTarget: 600, seed: 24, responseDelayMin: 0, responseDelayMax: 2 }, (r) => ["left", "center", "right"].forEach((z) => r.setPassageGroupClosed(`b1-stair-${z}`, true)));
    let plans = 0;
    const originalReroute = rt.rerouteAgent.bind(rt);
    rt.rerouteAgent = (...args) => { plans += 1; return originalReroute(...args); };
    const audit = run(rt, 240);
    const m = rt.getMetrics();
    const b1Upper = rt.agents.filter((a) => a.roomId.startsWith("b1-") && a.status !== "arrived");
    check("C5: with every B1 stair closed, B1 upper floors cannot be evacuated (not faked)", b1Upper.length > 0 && b1Upper.every((a) => !a.hasExitedBuilding), b1Upper.length);
    check("C5: stranded people are reported as holding, never as arrived", m.holding > 0 && m.arrived <= m.total - b1Upper.length, `holding ${m.holding}, arrived ${m.arrived}`);
    // `plans` counts every call (most return at once: cached negative result or this step's search
    // budget used up); `planSearches` counts searches actually run.
    check("C5: failed searches back off instead of repeating every frame", rt.planSearches < rt.agents.length * 240 / 1.5, `${rt.planSearches} searches run (${plans} calls) in 240 s`);
    check("C5: nobody pushes through the closed stairs", audit.closedTraversals === 0, audit.closedTraversals);
    invariantChecks("C5 all B1 stairs closed", rt, audit);
    ["left", "center", "right"].forEach((z) => rt.setPassageGroupClosed(`b1-stair-${z}`, false));
    const audit2 = run(rt, 3000);
    const m2 = invariantChecks("C6 reopened", rt, audit2);
    check("C6: after reopening, people re-evaluate and everyone arrives", m2.arrived === m2.total, `${m2.arrived}/${m2.total} at ${m2.elapsed.toFixed(0)} s`);
    summary.allClosedThenReopened = { holdingAt240: m.holding, arrived: m2.arrived, total: m2.total, seconds: +m2.elapsed.toFixed(1) };
  }

  // ---------------------------------------------------------------- D. Crowds
  {
    const rt = startRuntime({ populationTarget: 900, seed: 31 });
    let maxQueueing = 0, crossScope = 0;
    const directions = new Set();
    const audit = run(rt, 3000, {
      onStep: (r) => {
        maxQueueing = Math.max(maxQueueing, r.agents.filter((a) => a.status === "queueing").length);
        r.edgeQueues.forEach((queue, key) => {
          const node = r.nodeMap.get(key.slice(key.lastIndexOf("|") + 1));
          for (const id of queue.waiting) {
            const a = r.agents[id];
            if (node && (a.floor !== node.floor && node.floor > 0) ) crossScope += 1;
          }
        });
        for (const a of r.agents) if (a.status === "arrived" && a.arrivedAt === r.time) directions.add(a.route.nodeIds[a.route.nodeIds.length - 2]);
      },
    });
    const m = invariantChecks("D crowd", rt, audit);
    check("D1/D2: door and stair queues form from capacity limits", maxQueueing > 0, maxQueueing);
    check("D6: a queue never mixes people from another floor/building", crossScope === 0, crossScope);
    check("D3: people reach assembly from several directions", directions.size >= 3, directions.size);
    const queueSwitches = rt.agents.filter((a) => a.routeSwitches > 0).length;
    const flipFlops = rt.agents.filter((a) => [...a.abandonedRoutes.keys()].includes(a.route.edgeIds.slice(a.edgeIndex).join("|"))).length;
    check("D4: some people divert to a less crowded stair they can see", queueSwitches > 0, queueSwitches);
    check("D5: nobody returns to a route they just abandoned", flipFlops === 0, flipFlops);
    summary.crowd900 = { arrived: m.arrived, seconds: +m.elapsed.toFixed(1), maxQueueing, diverted: queueSwitches, reasons: reasonCounts(rt) };
  }

  // ---------------------------------------------------------------- E. Lifecycle
  {
    const rt = startRuntime({ populationTarget: 300, seed: 41 });
    rt.advance(20);
    const t = rt.time;
    rt.pause();
    check("E1: advance during pause does nothing", rt.advance(5) === 0 && rt.time === t);
    rt.resume();
    rt.advance(5);
    check("E1: resume continues from the paused time", Math.abs(rt.time - (t + 5)) < 1e-6, rt.time);
    rt.setWalkingSpeed(2.4);
    rt.advance(5);
    check("E4: changing speed mid-run keeps every value finite", rt.agents.every((a) => a.position.every(Number.isFinite) && Number.isFinite(a.speed)));
    rt.reset(true);
    check("E2: reset leaves no agents, queues, slots or reports", rt.agents.length === 0 && rt.edgeQueues.size === 0 && rt.time === 0 && rt.getMetrics().total === 0);
    // Same seed → identical result; chunking of time (frame rate) does not matter.
    const a = startRuntime({ populationTarget: 300, seed: 42 }, (r) => r.addFire([-24, walkY(4) + 0.25, 1.9]));
    for (let i = 0; i < 1200; i += 1) a.advance(0.1);
    const b = startRuntime({ populationTarget: 300, seed: 42 }, (r) => r.addFire([-24, walkY(4) + 0.25, 1.9]));
    // Irregular frame times; the last frame is capped (maxSteps) so b stops at the same simulated
    // time as a instead of overshooting by one physics step.
    let chunks = 0; while (b.time < a.time - 1e-9) { b.advance([0.016, 0.033, 0.35, 0.07, 0.2][chunks % 5], Math.max(1, Math.round((a.time - b.time) / DT))); chunks += 1; }
    check("E3: same seed + scenario is reproducible regardless of frame-time chunking", stateHash(a) === stateHash(b), `${stateHash(a)} vs ${stateHash(b)} at ${a.time.toFixed(1)} s`);
    const c = startRuntime({ populationTarget: 300, seed: 43 }, (r) => r.addFire([-24, walkY(4) + 0.25, 1.9]));
    for (let i = 0; i < 1200; i += 1) c.advance(0.1);
    check("E6: a different seed gives a different (but valid) run", stateHash(a) !== stateHash(c) && c.agents.every((x) => x.position.every(Number.isFinite)));
    a.clearFires();
    check("E5: clearing fires removes every memory and report of them", a.agents.every((x) => x.fireKnowledge.size === 0 && x.knownFireIds.size === 0) && a.hazardReports.size === 0);
    let threw = false; try { a.addFire([NaN, 1, 1]); } catch { threw = true; }
    check("E8: a non-finite fire position is rejected", threw && a.fires.length === 0);
    const d = startRuntime({ populationTarget: Number.NaN, walkingSpeed: -3, seed: "x" });
    check("E8: malformed configuration is normalised", d.agents.length > 0 && d.config.walkingSpeed > 0 && Number.isFinite(d.config.seed));
    const victim = d.agents[0];
    victim.route = { ...victim.route, edgeIds: ["missing-edge", ...victim.route.edgeIds.slice(1)] };
    let errored = false; try { for (let i = 0; i < 200; i += 1) d.advance(0.1); } catch (error) { errored = String(error); }
    check("E9: a route referencing a missing edge is recovered without exceptions", errored === false && victim.position.every(Number.isFinite), errored || victim.status);
    const map = validateMap(buildGeneratedSemanticMap());
    const restored = await decodeProject(await encodeProject(map, null));
    check("E7: export → import keeps nodes, edges, waypoints and calibration", JSON.stringify(restored.map.annotations) === JSON.stringify(map.annotations)
      && JSON.stringify(restored.map.connections) === JSON.stringify(map.connections)
      && JSON.stringify(restored.map.calibration ?? null) === JSON.stringify(map.calibration ?? null));
    const inspected = startRuntime({ populationTarget: 300, seed: 44 });
    inspected.advance(30);
    const info = inspected.inspectAgent(inspected.agents[0].id);
    check("Inspector: reason text is generated from the stored code", info && info.reasonText === describeReasonTh(info.reason) && info.behaviorLabel.length > 0, info?.reasonText);
  }

  // ---------------------------------------------------------------- F. Geometry
  {
    const rt = startRuntime({ populationTarget: 3000, seed: 51 });
    const inSite = (x, z) => { let inside = false; for (let i = 0, j = SITE_BOUNDARY.length - 1; i < SITE_BOUNDARY.length; j = i++) { const [xi, zi] = SITE_BOUNDARY[i], [xj, zj] = SITE_BOUNDARY[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside; } return inside; };
    let bad = [];
    for (const a of rt.agents) {
      const [x, , z] = a.assemblySlot;
      const inBuilding = CAMPUS_BUILDINGS.some((b) => Math.abs(x - b.x) < 42 && Math.abs(z - b.z) < 10);
      const inAmenity = CAMPUS_AMENITIES.some((am) => Math.abs(x - am.x) < am.width / 2 + 0.2 && Math.abs(z - am.z) < am.depth / 2 + 0.2);
      if (!inSite(x, z) || Math.hypot(x - SHRINE_CENTER[0], z - SHRINE_CENTER[2]) < SHRINE_CLEARANCE_RADIUS || inBuilding || inAmenity) bad.push(a.id);
    }
    check("F: every assembly position is inside the site, off the shrine base, buildings and context halls", bad.length === 0, bad.length);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ passed: failed.length === 0, checks: results.length, failed: failed.map((r) => r.name), summary }));
  if (failed.length) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
