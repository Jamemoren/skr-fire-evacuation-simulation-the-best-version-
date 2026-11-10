// The worked example (guide + presentation): the hand calculation must match the program.
//   node scripts/qa-route-example.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-route-example-"));
const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };
try {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck",
    "src/explain/routeExample.ts", "src/present/story/storyData.ts"], { cwd: root, stdio: "inherit" });
  const { computeRouteExample } = require(join(temp, "explain/routeExample.js"));
  const r = computeRouteExample();
  check("M1 every hand-calculated step cost equals the program's step cost", r.maxStepError < 1e-9, r.maxStepError);
  check("M2 the hand totals equal the program's route totals", Math.abs(r.routeA.total - r.routeA.programTotal) < 1e-9 && Math.abs(r.routeB.total - r.routeB.programTotal) < 1e-9,
    { A: [r.routeA.total, r.routeA.programTotal], B: [r.routeB.total, r.routeB.programTotal] });
  check("M3 the hand choice equals the program's choice (route A, centre stair)", r.handPick === r.programPick && r.programPick === "A", { hand: r.handPick, program: r.programPick, A: r.routeA.total.toFixed(3), B: r.routeB.total.toFixed(3) });
  check("M4 the break-even queue on the centre stair: hand = program", r.breakEvenHand === r.breakEvenProgram, { hand: r.breakEvenHand, program: r.breakEvenProgram, perPerson: r.perPerson });
  check("M5 a fire on the centre stair landing: the program avoids the centre stair", r.fire.avoidsCentre && r.fire.route?.rows.every((row) => Number.isFinite(row.cost)), r.fire.route?.nodeIds.length);
  check("M6 every ground-floor exit closed: the program finds no route", r.allExitsClosed.route === null, r.allExitsClosed.route?.length ?? "none");
  check("M7 both routes are 11 steps from room 203 to Zone C", r.routeA.rows.length === 11 && r.routeB.rows.length === 11);
  console.log(JSON.stringify({ A: r.routeA.total, B: r.routeB.total, breakEven: r.breakEvenHand, perPerson: r.perPerson, stair: r.stair }));

  // ---- the narrated story (presentation “เริ่มการสาธิต”) uses storyModel(): same numbers, checked here
  const { storyModel, substitute } = require(join(temp, "present/story/storyData.js"));
  const { createEvacuationGraph, stepCost } = require(join(temp, "simulation/graph.js"));
  const m = storyModel();
  const shown = (sub) => Number(sub.distanceTerm) + Number(sub.travel);
  for (const [name, d] of [["A (centre stair)", m.detail.A], ["B (longest step)", m.detail.B]]) {
    const recomputed = 0.28 * Number(d.sub.d) + Number(d.sub.d) / Number(d.sub.v);
    check(`S1 ${name}: the displayed d and v reproduce the displayed step cost`, d.sub.consistent && recomputed.toFixed(3) === d.sub.result && Math.abs(shown(d.sub) - Number(d.sub.result)) <= 0.0011,
      `${d.sub.expression} = ${recomputed.toFixed(4)} → ${d.sub.result} (program stepCost ${d.row.cost.toFixed(6)})`);
    check(`S2 ${name}: the step's displayed result equals the program's stepCost`, Number(d.sub.result) === Number(d.row.cost.toFixed(3)) && Math.abs(d.row.cost - d.row.handCost) < 1e-9);
  }
  check("S3 at 27 people the program keeps A, at 28 it switches to B (findPath)", m.breakEven.before.load === 27 && m.breakEven.before.programPick === "A" && m.breakEven.after.load === 28 && m.breakEven.after.programPick === "B"
    && m.breakEven.before.costA < m.breakEven.before.costB && m.breakEven.after.costA > m.breakEven.after.costB,
    { 27: [m.breakEven.before.costA.toFixed(3), m.breakEven.before.costB.toFixed(3)], 28: [m.breakEven.after.costA.toFixed(3), m.breakEven.after.costB.toFixed(3)] });
  check("S4 the chart (stepCost sums) gives findPath's choice and total at every queue 0…40", m.queue.every((q) => (q.costA <= q.costB ? "A" : "B") === q.programPick && Math.abs(Math.min(q.costA, q.costB) - q.programTotal) < 1e-9), m.queue.length);
  check("S5 route A grows exactly by L × perPerson (the equation shown)", m.queue.every((q) => Math.abs(q.costA - (r.routeA.total + q.load * m.perPerson.value)) < 1e-9) && m.queue.every((q) => Math.abs(q.costB - r.routeB.total) < 1e-9), m.perPerson.value);
  check("S6 fire: the closed steps are on route A, inside the flame, cost ∞; the new route avoids them and costs B's total", m.fire.blocked.length > 0
    && m.fire.blocked.every((edge) => edge.blocked && edge.fire >= 1 && edge.cost === Infinity && r.routeA.rows.some((row) => row.edgeId === edge.edgeId))
    && m.fire.route && !m.fire.route.rows.some((row) => m.fire.blocked.some((edge) => edge.edgeId === row.edgeId)) && Math.abs(m.fire.route.programTotal - r.routeB.total) < 1e-9,
    m.fire.blocked.map((edge) => edge.edgeId));
  const roundedSum = (calc) => calc.rows.reduce((sum, row) => sum + Number(row.handCost.toFixed(3)), 0);
  check("S7 rounding: totals are rounded once from the full values; the sum of rounded rows differs by ≤ 0.002 (stated on screen)",
    Math.abs(roundedSum(r.routeA) - Number(r.routeA.total.toFixed(3))) <= 0.0021 && Math.abs(roundedSum(r.routeB) - Number(r.routeB.total.toFixed(3))) <= 0.0021,
    { A: [roundedSum(r.routeA).toFixed(3), r.routeA.total.toFixed(3)], B: [roundedSum(r.routeB).toFixed(3), r.routeB.total.toFixed(3)] });
  // The story names the search “A*” and says it returns the cheapest route: true when the estimate
  // 0.34 × straight distance never exceeds a step's real cost (then it is consistent, and A* is exact).
  const graph = createEvacuationGraph();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  let worst = Infinity, steps = 0;
  for (const edge of graph.edges) {
    for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      const cost = stepCost(graph, edge.id, from, r.config, [], 0);
      if (!Number.isFinite(cost)) continue;
      const a = nodeById.get(from).position, b = nodeById.get(to).position;
      const straight = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (straight > 1e-6) { worst = Math.min(worst, cost / straight); steps += 1; }
    }
  }
  check("S8 the A* estimate (0.34 per metre) never exceeds a step's cost → the search returns the cheapest route", worst >= 0.34, { steps, lowestCostPerStraightMetre: worst.toFixed(3) });
  check("S9 the story's own checks all pass", Object.values(m.checks).every(Boolean), m.checks);
  void substitute;
} finally { rmSync(temp, { recursive: true, force: true }); }
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
