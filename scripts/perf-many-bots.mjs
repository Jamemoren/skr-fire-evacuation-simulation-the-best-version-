// Step-time check with many bots and a fire near busy rooms (Building 3 floor 3 gallery + Building 1 floor 5
// corridor). Prints mean / p95 / max ms per 0.1 s step. Usage: node scripts/perf-many-bots.mjs [repoRoot] [people] [seconds]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, Module } from "node:module";

const here = resolve(import.meta.dirname, "..");
const root = resolve(process.argv[2] ?? here);
const people = Number(process.argv[3] ?? 3000), seconds = Number(process.argv[4] ?? 90);
const temp = mkdtempSync(join(tmpdir(), "skr-perf-"));
process.env.NODE_PATH = resolve(here, "node_modules"); Module._initPaths();
const require = createRequire(import.meta.url);
try {
  execFileSync(process.execPath, [resolve(here, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck", join(root, "src/simulation/runtime.ts")], { cwd: root, stdio: "inherit" });
  const { EvacuationRuntime } = require(join(temp, "simulation/runtime.js"));
  const rt = new EvacuationRuntime();
  rt.start({ populationTarget: people, seed: 31, crowdBehavior: "grouped", fireSpreadEnabled: false, responseDelayMin: 0, responseDelayMax: 2 });
  for (const id of ["campus-b3-f3-gallery-5", "sim-corr-pink-f5-b3"]) rt.addFire([...rt.nodeMap.get(id).position], { startTime: -30, spreadRate: 0 });
  const times = [];
  for (let step = 0; step < seconds * 10 && !rt.completed; step += 1) {
    const t0 = performance.now(); rt.advance(0.1); times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const m = rt.getMetrics();
  const mean = times.reduce((s, v) => s + v, 0) / times.length;
  console.log(JSON.stringify({ root, people: rt.agents.length, simulated: +rt.time.toFixed(1), steps: times.length, meanMs: +mean.toFixed(2), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2), maxMs: +times[times.length - 1].toFixed(2), arrived: m.arrived, holding: m.holding }));
} finally { rmSync(temp, { recursive: true, force: true }); }
