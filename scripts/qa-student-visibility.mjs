import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-students-"));
try {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"),
    "--outDir", temp, "--target", "ES2020", "--module", "CommonJS", "--moduleResolution", "Node",
    "--esModuleInterop", "--skipLibCheck",
    ...["runtime", "studentPlacement", "studentVisibility"].map(name => resolve(root, `src/simulation/${name}.ts`)),
  ], { cwd: root, stdio: "pipe", timeout: 180000 });
  const testPath = join(temp, "students.cjs");
  writeFileSync(testPath, `
const assert = require('node:assert/strict');
const THREE = require(${JSON.stringify(resolve(root, "node_modules/three/build/three.cjs"))});
const { createWaitingStudents, normalizeStudentPopulation } = require('./simulation/studentPlacement.js');
const { yOffsetForRender, studentWorldBounds } = require('./simulation/studentVisibility.js');
const { EvacuationRuntime } = require('./simulation/runtime.js');
const { walkY } = require('./simulation/graph.js');
const { CLASSROOMS } = require('./building1/building1Data.js');
for (const count of [1, 40, 1500, 3000]) {
  const students = createWaitingStudents(count);
  assert.equal(students.length, count);
  assert.equal(new Set(students.map(s => s.id)).size, count);
  const runtime = new EvacuationRuntime();
  runtime.start({populationTarget:count, responseDelayMin:10, responseDelayMax:10});
  const live = runtime.getAgentRenderViews();
  assert.equal(live.length, count);
  students.forEach((student, i) => {
    assert.equal(student.floor >= 2 && student.floor <= 9, true);
    assert.equal(student.position[1], walkY(student.floor));
    assert.equal(student.status, 'waiting');
    assert.equal(live[i].roomId, student.roomId);
    assert.equal(live[i].gender, student.gender);
    assert.deepEqual(live[i].position, student.position);
  });
  for (let floor=2; floor<=9; floor++) {
    const view = {viewMode:'interior', selectedFloor:floor, explodeFloors:false};
    const expected = students.filter(s => s.floor === floor).length;
    assert.equal(students.filter(s => yOffsetForRender(s.floor,view) !== null).length, expected);
    if (count === 3000) assert.equal(expected, 375);
    for (const s of students) {
      const offset = yOffsetForRender(s.floor,{...view, explodeFloors:true});
      assert.equal(offset, s.floor === floor ? (floor-1)*1.1 : null);
    }
  }
  const snapshot = JSON.stringify(runtime.getAgentSnapshots());
  runtime.pause(); runtime.step(1);
  assert.equal(JSON.stringify(runtime.getAgentSnapshots()),snapshot);
  runtime.reset();
  assert.equal(runtime.getAgentRenderViews().length,0);
  assert.equal(createWaitingStudents(count).length,count);
}
assert.equal(normalizeStudentPopulation(NaN),3000);
assert.equal(normalizeStudentPopulation(Infinity),3000);
assert.equal(normalizeStudentPopulation(-5),1);
assert.equal(normalizeStudentPopulation(1500.6),1501);
assert.equal(normalizeStudentPopulation(99999),3000);
assert.equal(yOffsetForRender(0,{viewMode:'exterior',selectedFloor:9,explodeFloors:true}),0);
assert.equal(yOffsetForRender(1,{viewMode:'exterior',selectedFloor:9,explodeFloors:true}),0);
const students = createWaitingStudents(3000);
assert.equal(new Set(students.map(s => s.roomId)).size,CLASSROOMS.length);
for (const mode of ['exterior','structure','cutaway','interior','single-floor']) {
  const b = {viewMode:mode, selectedFloor:5, explodeFloors:false};
  const eligible = students.filter(s => yOffsetForRender(s.floor,b) !== null);
  assert.equal(eligible.length, mode==='cutaway' ? 1500 : mode==='interior'||mode==='single-floor' ? 375 : 3000);
}
// Reproduce the old local-space culling failure after translating/rotating/scaling a model.
let reproducedOldFailure = false;
for (const factor of [0.4,1,2.5]) {
  const world = new THREE.Matrix4().compose(new THREE.Vector3(120,35,-80),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),1.1),new THREE.Vector3(factor,factor,factor));
  const local = [-24,7.2,-5];
  const offset = 2.2;
  const center = new THREE.Vector3(local[0],local[1]+offset+.8,local[2]).applyMatrix4(world);
  const camera = new THREE.PerspectiveCamera(55,1.5,.03,1000);
  camera.position.copy(center).add(new THREE.Vector3(0,4,12));
  camera.lookAt(center); camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const bounds = studentWorldBounds(new THREE.Sphere(),local,offset,world);
  assert.equal(frustum.intersectsSphere(bounds),true);
  assert.ok(bounds.center.distanceTo(center)<1e-8);
  assert.ok(Math.abs(bounds.radius-.9*factor)<1e-8);
  const oldBounds = new THREE.Sphere(new THREE.Vector3(local[0],local[1]+.8,local[2]),.9);
  if (!frustum.intersectsSphere(oldBounds)) reproducedOldFailure=true;
}
assert.equal(reproducedOldFailure,true);
console.log(JSON.stringify({population:3000, rooms:96, perFloor:375, spawnParity:true, reset:true, allViews:true, explodedFloors:true, calibratedFrustum:true}));
`);
  const result = execFileSync(process.execPath, [testPath], { cwd: root, encoding: "utf8", timeout: 180000 }).trim();
  console.log(`Student Visibility QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Student Visibility QA ไม่ผ่าน");
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
