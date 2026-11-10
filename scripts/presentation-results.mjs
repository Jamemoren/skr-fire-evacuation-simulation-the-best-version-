// Scenario matrix with fixed seeds: the measured results the presentation shows (scene 2 and 5)
// and the evidence for the simulation checks. Every run is the real runtime, same code as the web.
//
//   node scripts/presentation-results.mjs            → public/presentation/results.json
//   node scripts/presentation-results.mjs --quick    → 600 people, for a fast smoke check
//
// For each scenario it records the conditions, the head count by status (must add up to the start),
// the people still inside with their reasons, arrival times, the busiest bottlenecks, a time series,
// and physical checks (no topology violation, no wall correction, no step longer than walking allows,
// nobody standing in flame).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const quick = process.argv.includes("--quick");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const temp = mkdtempSync(join(tmpdir(), "skr-presentation-results-"));
const require = createRequire(import.meta.url);
// The site's "ทดสอบ 1,500" preset: a full 3,000-person run takes ~30 min of computer time per scenario.
const POPULATION = quick ? 600 : 1500;
const SEED = 7;
const TIME_LIMIT = 1500; // simulated seconds

try {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck",
    "src/simulation/runtime.ts"], { cwd: root, stdio: "inherit" });
  const { EvacuationRuntime } = require(join(temp, "simulation/runtime.js"));
  const { createEvacuationGraph, pointRisk } = require(join(temp, "simulation/graph.js"));
  const { BRIDGE_EDGE_ID } = require(join(temp, "simulation/bridge.js"));
  const graph = createEvacuationGraph();
  const node = (id) => graph.nodes.find((item) => item.id === id).position;
  const offset = (p, dx, dz) => [p[0] + dx, p[1], p[2] + dz];
  const exitEdges = graph.edges.filter((edge) => /^edge-(left|center|right)-door-exit$/.test(edge.id) || /^campus-b[34]-exit-door-\d$/.test(edge.id)).map((edge) => edge.id);

  const scenarios = [
    { id: "no-fire", title: "ไม่มีไฟ (แนวทางสมดุล)", preset: "balanced" },
    { id: "no-fire-fastest", title: "ไม่มีไฟ (แนวทางเร็วที่สุด)", preset: "fastest", compare: true },
    { id: "no-fire-safest", title: "ไม่มีไฟ (แนวทางปลอดภัยที่สุด)", preset: "safest", compare: true },
    // Against the railing side of the 3.2 m corridor, 2 m from room 503's door: about 2.3 m stays clear.
    { id: "fire-near-door", title: "ไฟเล็กชิดราวทางเดินใกล้ประตูห้อง 503 (ยังเดินอ้อมผ่านได้)", preset: "balanced",
      fires: [{ position: offset(node("sim-corr-pink-f5-b3"), 2, 1.25), fireRadius: 0.5, smokeRadius: 2.2, spreadRate: 0 }], spread: false },
    { id: "fire-blocks-corridor", title: "ไฟปิดโถงทางเดินปีกซ้าย ชั้น 5", preset: "balanced",
      fires: [{ position: node("sim-corr-pink-f5-b3"), fireRadius: 2.4, smokeRadius: 6, spreadRate: 0 }], spread: false },
    { id: "fire-blocks-stair", title: "ไฟปิดบันไดกลาง ชั้น 5", preset: "balanced",
      fires: [{ position: node("sim-stair-center-f5"), fireRadius: 2.4, smokeRadius: 6, spreadRate: 0 }], spread: false },
    { id: "fire-blocks-stair-fastest", title: "ไฟปิดบันไดกลาง ชั้น 5 (แนวทางเร็วที่สุด)", preset: "fastest", compare: true,
      fires: [{ position: node("sim-stair-center-f5"), fireRadius: 2.4, smokeRadius: 6, spreadRate: 0 }], spread: false },
    { id: "coordinated", title: "ไม่มีไฟ · ระบบวางแผนรวม (coordinated)", preset: "balanced", decisionMode: "coordinated", compare: true },
    { id: "fire-blocks-stair-coordinated", title: "ไฟปิดบันไดกลาง ชั้น 5 · ระบบวางแผนรวม", preset: "balanced", decisionMode: "coordinated", compare: true,
      fires: [{ position: node("sim-stair-center-f5"), fireRadius: 2.4, smokeRadius: 6, spreadRate: 0 }], spread: false },
    { id: "bridge-closed", title: "ทางเชื่อมอาคาร 3–4 ใช้ไม่ได้", preset: "balanced", closed: [BRIDGE_EDGE_ID] },
    { id: "fire-spreads", title: "ไฟลามระหว่างอพยพ (เริ่มที่โถงปีกซ้าย ชั้น 3)", preset: "balanced",
      fires: [{ position: node("sim-corr-pink-f3-b3") }], spread: true },
    { id: "all-exits-closed", title: "ทุกทางออกชั้นล่างถูกปิด", preset: "balanced", closed: exitEdges, limit: 300 },
    { id: "full-population", title: "ประชากรเต็ม 3,000 คน · ไม่มีไฟ", preset: "balanced", population: quick ? 600 : 3000, limit: 2400 },
  ].filter((scenario) => !only || only.includes(scenario.id));

  const hash = createHash("sha256");
  for (const file of ["src/simulation/runtime.ts", "src/simulation/graph.ts", "src/simulation/campusGraph.ts", "src/simulation/fireField.ts"]) hash.update(readFileSync(resolve(root, file)));
  const codeHash = hash.digest("hex").slice(0, 12);
  // Each finished scenario is saved at once (artifacts/presentation-parts/), so an interrupted run
  // resumes where it stopped, and scenarios can run in several processes (--only=a,b) then --merge.
  const partsDir = resolve(root, "artifacts/presentation-parts" + (quick ? "-quick" : ""));
  mkdirSync(partsDir, { recursive: true });
  const partPath = (id) => resolve(partsDir, `${id}.json`);
  const readPart = (id) => { try { const part = JSON.parse(readFileSync(partPath(id), "utf8")); return part.codeHash === codeHash ? part.run : null; } catch { return null; } };
  const merge = process.argv.includes("--merge");
  const runs = [];
  for (const scenario of scenarios) {
    const saved = readPart(scenario.id);
    if (saved || merge) {
      if (saved) { runs.push(saved); console.log(`${scenario.id.padEnd(26)} (saved part, code ${codeHash})`); }
      else console.log(`${scenario.id.padEnd(26)} MISSING — run it first`);
      continue;
    }
    const started = Date.now();
    const rt = new EvacuationRuntime();
    for (const fire of scenario.fires ?? []) rt.addFire([...fire.position], { ...fire, position: undefined });
    if (scenario.closed?.length) rt.setPassageClosed(scenario.closed, true);
    rt.start({ populationTarget: scenario.population ?? POPULATION, preset: scenario.preset, seed: SEED, fireSpreadEnabled: scenario.spread ?? true, decisionMode: scenario.decisionMode ?? "occupant" });
    const total = rt.agents.length;
    const series = [];
    let maxJump = 0, walkedIntoFlame = 0, overtakenByFlame = 0;
    let last = new Map(rt.agents.map((agent) => [agent.id, [...agent.position]]));
    const limit = scenario.limit ?? TIME_LIMIT;
    let nextSample = 0;
    while (!rt.completed && rt.time < limit) {
      rt.advance(0.1);
      for (const agent of rt.agents) {
        const prev = last.get(agent.id);
        if (prev && agent.status !== "arrived") maxJump = Math.max(maxJump, Math.hypot(agent.position[0] - prev[0], agent.position[2] - prev[2]));
        if (agent.status !== "arrived" && agent.status !== "incapacitated" && pointRisk(agent.position, rt.fires, rt.time).blocked) {
          // Walking into flame (forbidden) vs. the flame front growing over someone who stood still or
          // was already there (the model then incapacitates them — reported, not hidden).
          const moved = prev && Math.hypot(agent.position[0] - prev[0], agent.position[2] - prev[2]) > 0.01;
          if (moved && !pointRisk(prev, rt.fires, rt.time).blocked) walkedIntoFlame += 1; else overtakenByFlame += 1;
        }
        last.set(agent.id, [...agent.position]);
      }
      if (rt.time >= nextSample) {
        nextSample += 5;
        const m = rt.getMetrics();
        const top = m.bottlenecks[0];
        series.push({ t: Math.round(rt.time), arrived: m.arrived, queueing: m.queueing, inside: m.indoorAgents + m.stairAgents, top: top ? { edgeId: top.edgeId, name: top.name, queueSeconds: Math.round(top.queueSeconds * 10) / 10 } : null });
      }
    }
    const m = rt.getMetrics();
    const byStatus = {};
    for (const agent of rt.agents) byStatus[agent.status] = (byStatus[agent.status] ?? 0) + 1;
    const counted = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
    const ids = new Set(rt.agents.map((agent) => agent.id));
    const inside = rt.agents.filter((agent) => agent.status !== "arrived" && agent.status !== "incapacitated");
    const reasons = {};
    for (const agent of inside) reasons[agent.reason?.code ?? "unknown"] = (reasons[agent.reason?.code ?? "unknown"] ?? 0) + 1;
    const run = {
      id: scenario.id, title: scenario.title, compare: !!scenario.compare,
      conditions: { population: total, preset: scenario.preset, decisionMode: scenario.decisionMode ?? "occupant", seed: SEED, fireSpreadEnabled: scenario.spread ?? true, fires: (scenario.fires ?? []).map((fire) => ({ position: fire.position.map((v) => Math.round(v * 100) / 100), fireRadius: fire.fireRadius ?? null, spreadRate: fire.spreadRate ?? null })), closedEdges: scenario.closed ?? [], timeLimit: limit },
      result: {
        simulatedSeconds: Math.round(rt.time * 10) / 10, completed: rt.completed,
        arrived: m.arrived, incapacitated: m.incapacitated, stillInside: inside.length, byStatus,
        insideReasons: reasons, stuckReasons: m.stuckReasons,
        firstArrival: m.firstArrival, p50Arrival: m.p50Arrival, p90Arrival: m.p90Arrival, finalArrival: m.finalArrival,
        rerouteCount: m.rerouteCount, bottlenecks: m.bottlenecks.slice(0, 3).map((b) => ({ edgeId: b.edgeId, name: b.name, queueSeconds: Math.round(b.queueSeconds * 10) / 10, capacityPerSecond: b.capacityPerSecond, utilization: Math.round(b.utilization * 1000) / 1000 })),
        maxQueue: Math.round(m.maxQueue * 100) / 100, peakEdgeDensity: Math.round(m.peakEdgeDensity * 100) / 100, dangerousCrowdSeconds: Math.round(m.dangerousCrowdSeconds * 10) / 10,
      },
      checks: {
        headCountMatches: counted === total && ids.size === total && m.arrived + m.incapacitated + inside.length === total,
        topologyViolations: m.topologyViolations, collisionCorrections: m.collisionCorrections, stateInconsistencies: m.stateInconsistencies,
        maxStepMetres: Math.round(maxJump * 1000) / 1000, walkedIntoFlame, overtakenByFlame,
      },
      series,
      runMs: Date.now() - started,
    };
    runs.push(run);
    writeFileSync(partPath(scenario.id), JSON.stringify({ codeHash, run }));
    console.log(`${scenario.id.padEnd(26)} ${String(m.arrived).padStart(5)}/${total} arrived · inside ${inside.length} · t=${run.result.simulatedSeconds}s · p90 ${m.p90Arrival?.toFixed?.(1) ?? "-"} · head count ${run.checks.headCountMatches ? "OK" : "MISMATCH"} · topo ${m.topologyViolations} · walls ${m.collisionCorrections} · maxStep ${run.checks.maxStepMetres} · intoFlame ${walkedIntoFlame} · overtaken ${overtakenByFlame} · ${Math.round(run.runMs / 1000)}s`);
  }
  const output = {
    generatedAt: new Date().toISOString(),
    command: `node scripts/presentation-results.mjs${quick ? " --quick" : ""}`,
    codeHash,
    node: process.version,
    note: "ผลจากการรันระบบจำลองจริง (runtime เดียวกับเว็บ) ด้วย seed คงที่ — รันซ้ำได้ด้วยคำสั่งข้างต้น",
    runs,
  };
  if (!only && runs.length === scenarios.length) {
    const out = resolve(root, quick ? "artifacts/presentation-results-quick.json" : "public/presentation/results.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(output, null, 1));
    console.log(`\nwritten ${out}`);
  }
  const bad = runs.filter((run) => !run.checks.headCountMatches || run.checks.topologyViolations || run.checks.collisionCorrections || run.checks.stateInconsistencies || run.checks.walkedIntoFlame || run.checks.maxStepMetres > 1);
  if (bad.length) { console.error("checks failed:", bad.map((run) => run.id).join(", ")); process.exitCode = 1; }
} finally { rmSync(temp, { recursive: true, force: true }); }
