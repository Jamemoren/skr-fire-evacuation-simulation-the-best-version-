import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tscBin = resolve(root, "node_modules/typescript/bin/tsc");
const temp = mkdtempSync(join(tmpdir(), "skr-semantic-parity-"));
const files = [
  "src/types.ts",
  "src/building1/building1Data.ts",
  "src/simulation/types.ts",
  "src/simulation/walkable.ts",
  "src/simulation/graph.ts",
  "src/simulation/semanticGraph.ts",
].map((file) => resolve(root, file));

try {
  execFileSync(process.execPath, [tscBin,
    "--outDir", temp,
    "--target", "ES2020",
    "--module", "CommonJS",
    "--moduleResolution", "Node",
    "--esModuleInterop",
    "--skipLibCheck",
    ...files,
  ], { cwd: root, stdio: "pipe", timeout: 30000 });

  const testPath = join(temp, "qa-semantic-parity.cjs");
  writeFileSync(testPath, `
const fs = require('fs');
const { createEvacuationGraph } = require('./simulation/graph.js');
const { buildGeneratedSemanticMap } = require('./simulation/semanticGraph.js');
const graph = createEvacuationGraph();
const generated = buildGeneratedSemanticMap();
const staticMap = JSON.parse(fs.readFileSync(${JSON.stringify(resolve(root, "examples/building1-semantic-map.json"))}, 'utf8'));
const graphNodeIds = new Set(graph.nodes.map(node => node.id));
const graphEdgeIds = new Set(graph.edges.map(edge => edge.id));
const generatedIds = new Set(generated.annotations.map(item => item.id));
const generatedEdgeIds = new Set(generated.connections.map(item => item.id));
const staticIds = new Set(staticMap.annotations.map(item => item.id));
const staticEdgeIds = new Set(staticMap.connections.map(item => item.id));
for (const id of graphNodeIds) if (!generatedIds.has(id)) throw new Error('generated semantic map missing graph node ' + id);
for (const id of graphEdgeIds) if (!generatedEdgeIds.has(id)) throw new Error('generated semantic map missing graph edge ' + id);
for (const id of graphNodeIds) if (!staticIds.has(id)) throw new Error('static semantic map missing graph node ' + id);
for (const id of graphEdgeIds) if (!staticEdgeIds.has(id)) throw new Error('static semantic map missing graph edge ' + id);
const classrooms = staticMap.annotations.filter(item => item.type === 'classroom');
const people = classrooms.reduce((sum,item) => sum + Number(item.peopleCount || 0), 0);
if (classrooms.length !== 96 || people !== 3000) throw new Error('semantic population mismatch: ' + classrooms.length + ' rooms / ' + people + ' people');
const byId = new Map(staticMap.annotations.map(item => [item.id, item]));
for (const edge of staticMap.connections) {
  const from = byId.get(edge.fromId), to = byId.get(edge.toId);
  if (from?.type === 'classroom' && to?.type === 'stair') throw new Error('semantic Room -> Stair shortcut: ' + edge.id);
  if (from?.type === 'classroom' && to?.type !== 'door') throw new Error('semantic classroom bypasses physical door: ' + edge.id);
}
if (staticMap.project.schoolName !== 'โรงเรียนสวนกุหลาบวิทยาลัย รังสิต') throw new Error('school metadata mismatch: ' + staticMap.project.schoolName);
console.log(JSON.stringify({graphNodes:graph.nodes.length,graphEdges:graph.edges.length,semanticAnnotations:staticMap.annotations.length,semanticConnections:staticMap.connections.length,classrooms:classrooms.length,people,school:staticMap.project.schoolName}));
`);

  const result = execFileSync(process.execPath, [testPath], { cwd: temp, encoding: "utf8", timeout: 30000 }).trim();
  console.log(`Semantic Graph Parity QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Semantic Graph Parity QA ไม่ผ่าน");
  if (error?.stdout) console.error(String(error.stdout));
  if (error?.stderr) console.error(String(error.stderr));
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
