import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type * as THREE from "three";
import { GENERATED_MODEL_HASH, LEGACY_PROJECT_NAME_TH, PROJECT_NAME_TH } from "../projectIdentity";
import { useMapperStore } from "../store";
import { useBuilding1Store } from "../building1/building1Store";
import { useEvacuationStore } from "../simulation/simulationStore";
import { buildGeneratedSemanticMap } from "../simulation/semanticGraph";
import { PREVIOUS_SITE_LAYOUT, SITE_LAYOUT } from "../building1/siteLayout";
import { buildSemanticMap } from "./semantic";
import { clearModelFile, loadModelFile, saveModelFile, saveSimulationBackup, type ProjectBackup } from "./idb";
import { sha256File } from "./hash";
import { decodeProject, encodeProject, validateMap } from "./portableProject";
import type { SemanticMapFile } from "../types";

let busy = false;
let restored: Promise<void> | null = null;

async function exclusive<T>(task: () => Promise<T>): Promise<T> {
  if (busy) throw new Error("กรุณารอให้การนำเข้าหรือส่งออกครั้งก่อนเสร็จ");
  busy = true;
  useMapperStore.setState({ projectBusy: true });
  try { return await task(); }
  finally { busy = false; useMapperStore.setState({ projectBusy: false }); }
}

export function currentMap(): SemanticMapFile {
  const state = useMapperStore.getState();
  return structuredClone(buildSemanticMap({
    ...state, model: state.modelSource,
    editor: { showGrid: state.showGrid, showLabels: state.showLabels, showModel: state.showModel,
      modelOpacity: state.modelOpacity, snapEnabled: state.snapEnabled, snapSize: state.snapSize, hiddenTypes: state.hiddenTypes },
  }));
}

async function validateGlb(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength < 20) throw new Error("ไฟล์ GLB ไม่ครบ");
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== file.size) throw new Error("ต้องเป็นโมเดล GLB เวอร์ชัน 2 ที่สมบูรณ์");
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== 0x4e4f534a || jsonLength > 32 * 1024 * 1024 || 20 + jsonLength > file.size) throw new Error("ส่วนข้อมูล GLB ไม่ถูกต้อง");
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  for (const resource of [...json.buffers ?? [], ...json.images ?? []]) {
    if (resource.uri && !String(resource.uri).startsWith("data:")) throw new Error("GLB ต้องฝัง texture และข้อมูลไว้ในไฟล์เดียว กรุณา Export แบบ GLB จาก Blender");
  }
  const draco = new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.5/");
  let gltf;
  try {
    gltf = await new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, "");
  } finally { draco.dispose(); }
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  });
  return sha256File(file);
}

async function rememberModel(file: File | null, hash: string): Promise<void> {
  try {
    if (file) await saveModelFile(file, hash);
    else await clearModelFile();
  } catch {
    useMapperStore.getState().addToast("warning", "เปิดใช้งานได้ในครั้งนี้ แต่เบราว์เซอร์บันทึกโมเดลไม่สำเร็จ ควรส่งออกโปรเจกต์เก็บไว้");
  }
}

function replaceWorkspace(map: SemanticMapFile, url: string | null): void {
  map = upgradeStandardSimulationProject(map);
  const oldUrl = useMapperStore.getState().modelUrl;
  useMapperStore.setState({
    workspaceInitialized: true, project: map.project, modelSource: map.model,
    modelUrl: url, modelReport: null, modelError: null, modelLoading: Boolean(url),
    calibration: map.calibration, annotations: map.annotations, connections: map.connections,
    objects: map.objects ?? {}, modelObjects: [], selectedObjectId: null,
    selectedAnnotationId: null, selectedConnectionId: null, inspectedHit: null, targetHit: null,
    connectFromId: null, draft: null, past: [], future: [], editSnapshot: null, transformDragging: false,
    showModel: true, hiddenTypes: [], ...map.editor, measurement: { start: null, end: null },
  });
  if (oldUrl?.startsWith("blob:") && oldUrl !== url) URL.revokeObjectURL(oldUrl);
  useBuilding1Store.getState().setFocusMode(false);
  useEvacuationStore.getState().reset();
  useEvacuationStore.getState().setWorkMode("editor");
}

export async function importWorkspaceFile(file: File): Promise<void> {
  return exclusive(async () => {
    const name = file.name.toLowerCase();
    if (name.endsWith(".skrproject")) {
      const { map, asset } = await decodeProject(file);
      if (asset) {
        const hash = await validateGlb(asset);
        if (hash !== map.model.sha256) throw new Error("SHA-256 ของ GLB ไม่ตรงกับโปรเจกต์ ไฟล์อาจไม่ครบ");
      }
      await rememberModel(asset, map.model.sha256);
      replaceWorkspace(map, asset ? URL.createObjectURL(asset) : null);
    } else if (name.endsWith(".glb")) {
      const hash = await validateGlb(file);
      const state = useMapperStore.getState();
      let sameModel = state.modelSource.sha256 === hash;
      if (!state.modelSource.sha256 && ["uploaded", "public"].includes(state.modelSource.source) && state.annotations.length
        && (state.modelSource.name === file.name || state.modelSource.size === file.size)) {
        if (!window.confirm("โมเดลเดิมไม่มี SHA-256 ยืนยันว่าไฟล์นี้เป็นโมเดลต้นฉบับ และต้องการเก็บ Calibration กับ node/edge เดิมหรือไม่?")) return;
        sameModel = true;
      }
      const map = currentMap();
      if (!sameModel && (map.annotations.length || Object.keys(map.objects ?? {}).length) &&
        !window.confirm("โมเดลใหม่ใช้ระบบพิกัดของตัวเอง ต้องการเริ่มแผนที่ว่างกับโมเดลนี้หรือไม่? ควรส่งออกโปรเจกต์ปัจจุบันเก็บก่อน")) return;
      map.model = { name: file.name, size: file.size, sha256: hash, source: "uploaded" };
      if (!sameModel) {
        map.annotations = []; map.connections = []; map.objects = {};
        if (map.editor) map.editor.showModel = true;
        map.calibration = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
        map.project = { ...map.project, name: file.name.replace(/\.glb$/i, ""), updatedAt: new Date().toISOString() };
      }
      await rememberModel(file, hash);
      replaceWorkspace(map, URL.createObjectURL(file));
    } else if (name.endsWith(".json")) {
      const map = validateMap(JSON.parse(await file.text()));
      const state = useMapperStore.getState();
      if (map.model.source === "uploaded" || map.model.source === "public") {
        if (!state.modelUrl || (map.model.sha256 && state.modelSource.sha256 !== map.model.sha256)) throw new Error("นำเข้า GLB ต้นฉบับที่ตรงกันก่อน แล้วนำเข้า JSON อีกครั้ง หรือใช้ไฟล์ .skrproject ที่รวมโมเดลมาแล้ว");
        if (!map.model.sha256 && !window.confirm("แผนที่รุ่นเดิมไม่มี SHA-256 ยืนยันว่า GLB ที่เปิดอยู่เป็นโมเดลต้นฉบับของแผนที่นี้หรือไม่?")) return;
        map.model = state.modelSource;
        useMapperStore.setState({ modelSource: map.model });
        state.importMap(map);
        useEvacuationStore.getState().reset();
        useEvacuationStore.getState().setWorkMode("editor");
      } else {
        await rememberModel(null, "");
        replaceWorkspace(map, null);
      }
    } else throw new Error("รองรับ .glb, .json และ .skrproject");
    useMapperStore.getState().addToast("success", "เปิดโครงการแล้ว พร้อมแก้ไขต่อ");
  });
}

async function packWorkspace(): Promise<Blob> {
    if (useMapperStore.getState().transformDragging) throw new Error("ปล่อยเมาส์เพื่อจบการย้ายวัตถุก่อนส่งออก");
    const map = currentMap();
    let asset: Blob | null = null;
    if (map.model.source === "uploaded" || map.model.source === "public") {
      const url = useMapperStore.getState().modelUrl;
      if (!url) throw new Error("กรุณานำเข้า GLB ต้นฉบับที่ตรงกับแผนที่ก่อนส่งออก");
      const response = await fetch(url);
      if (!response.ok) throw new Error("อ่านไฟล์โมเดลไม่สำเร็จ");
      asset = await response.blob();
      const hash = await sha256File(asset);
      if (map.model.sha256 && map.model.sha256 !== hash) throw new Error("GLB ปัจจุบันไม่ตรงกับข้อมูลแผนที่");
      map.model = { ...map.model, sha256: hash, size: asset.size, source: "uploaded" };
    }
    validateMap(map);
    return encodeProject(map, asset);
}

export async function exportWorkspace(): Promise<Blob> {
  return exclusive(packWorkspace);
}

/** A failed backup must leave the original nodes, calibration and model intact. */
export async function repairSimulationWorkspace(): Promise<ProjectBackup> {
  return exclusive(async () => {
    if (isDefaultSimulationProject(currentMap())) throw new Error("ผังนี้พร้อมจำลองแล้ว ไม่จำเป็นต้องคืนค่าผัง");
    const createdAt = new Date().toISOString();
    const backup: ProjectBackup = {
      id: "simulation-recovery",
      name: `skr-before-simulation-${createdAt.replace(/[:.]/g, "-")}.skrproject`,
      createdAt,
      blob: await packWorkspace(),
    };
    await saveSimulationBackup(backup);
    const map = buildGeneratedSemanticMap();
    map.project = { ...useMapperStore.getState().project };
    replaceWorkspace(map, null);
    useEvacuationStore.getState().setWorkMode("simulation");
    return backup;
  });
}

export function restoreWorkspace(): Promise<void> {
  if (restored) return restored;
  restored = exclusive(async () => {
    let state = useMapperStore.getState();
    if (!state.workspaceInitialized) {
      if (!state.annotations.length && state.modelSource.source === "generated") {
        state.importMap(buildGeneratedSemanticMap());
        useMapperStore.setState({ modelSource: { ...state.modelSource, sha256: GENERATED_MODEL_HASH } });
      } else useMapperStore.setState({ workspaceInitialized: true });
    }
    state = useMapperStore.getState();
    if (state.project.name === LEGACY_PROJECT_NAME_TH) state.patchProject({ name: PROJECT_NAME_TH });
    // Restore saved work without changing the startup page. Explicit file imports
    // still open the editor; reopening the website starts on the main simulation.
    if (state.modelSource.source === "uploaded" || state.modelSource.source === "public") {
      useBuilding1Store.getState().setFocusMode(false);
      useMapperStore.setState({ modelLoading: true });
      try {
        const stored = await loadModelFile();
        if (!stored || stored.sha256 !== state.modelSource.sha256) throw new Error("กรุณาเลือก GLB ต้นฉบับอีกครั้ง หรือเปิดไฟล์ .skrproject ข้อมูล calibration และ node/edge ของคุณยังอยู่ครบ");
        useMapperStore.setState({ modelUrl: URL.createObjectURL(stored.blob) });
      } catch (error) {
        useMapperStore.setState({ modelError: error instanceof Error ? error.message : "อ่านโมเดลที่บันทึกไว้ไม่สำเร็จ", modelLoading: false });
      }
    } else if (canUpgradeSimulationProject(currentMap())) {
      // Upgrade only the exact unedited previous template; preserve user calibration.
      const map=buildGeneratedSemanticMap();
      map.project=state.project;
      // Retain labels and display preferences even when the physical template is unchanged.
      const previousNodes=new Map(state.annotations.map(a=>[a.id,a]));
      const previousEdges=new Map(state.connections.map(e=>[e.id,e]));
      map.annotations=map.annotations.map(a=>{
        const old=previousNodes.get(a.id);
        return old ? {...a,name:old.name,notes:old.notes,tags:old.tags,visible:old.visible,locked:old.locked} : a;
      });
      map.connections=map.connections.map(e=>({...e,notes:previousEdges.get(e.id)?.notes??e.notes}));
      state.importMap(map);
    } else if (!isDefaultSimulationProject(currentMap())) {
      useBuilding1Store.getState().setFocusMode(false);
    }
  });
  return restored;
}

export async function newWorkspace(): Promise<void> {
  return exclusive(async () => {
    const map = currentMap();
    const timestamp = new Date().toISOString();
    map.project = { name: "โปรเจกต์ใหม่", schoolName: "", description: "", createdAt: timestamp, updatedAt: timestamp };
    map.model = { name: "พื้นที่ว่าง", size: 0, sha256: "", source: "empty" };
    map.annotations = []; map.connections = []; map.objects = {};
    map.calibration = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
    await rememberModel(null, "");
    replaceWorkspace(map, null);
  });
}

export async function openSampleWorkspace(): Promise<void> {
  return exclusive(async () => {
    const map = buildGeneratedSemanticMap();
    await rememberModel(null, "");
    replaceWorkspace(map, null);
  });
}

function geometrySignature(map: SemanticMapFile, includeWaypoints = true): string {
  return JSON.stringify({
    nodes: map.annotations.map(({ id, type, shape, position, rotation, size, floor, peopleCount, capacity }) =>
      ({ id, type, shape, position, rotation, size, floor, peopleCount, capacity })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: map.connections.map(({ id, fromId, toId, type, width, capacityPerSecond, bidirectional, enabled, waypoints }) =>
      ({ id, fromId, toId, type, width, capacityPerSecond, bidirectional, enabled, ...(includeWaypoints ? { waypoints: waypoints ?? [] } : {}) })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}
const templateSignature = geometrySignature(buildGeneratedSemanticMap());
const previousTemplateSignatures = new Set([
  geometrySignature(buildGeneratedSemanticMap(false,PREVIOUS_SITE_LAYOUT,true,true)),
  geometrySignature(buildGeneratedSemanticMap(true,PREVIOUS_SITE_LAYOUT,true,true)),
  geometrySignature(buildGeneratedSemanticMap(true,SITE_LAYOUT,false,true)),
]);
const previousDoorCenterSignature = geometrySignature(buildGeneratedSemanticMap(true,SITE_LAYOUT,true,true));
function canUpgradeSimulationProject(map: SemanticMapFile): boolean {
  return isUneditedGeneratedProject(map) && (geometrySignature(map) === previousDoorCenterSignature
    || previousTemplateSignatures.has(geometrySignature(map)));
}

/** Upgrade an exact old standard map, never custom nodes, geometry or calibration. */
export function upgradeStandardSimulationProject(map: SemanticMapFile): SemanticMapFile {
  if (!canUpgradeSimulationProject(map)) return map;
  const next = buildGeneratedSemanticMap();
  next.project = map.project;
  next.editor = map.editor;
  const nodes = new Map(map.annotations.map(node => [node.id, node]));
  const edges = new Map(map.connections.map(edge => [edge.id, edge]));
  next.annotations = next.annotations.map(node => {
    const old = nodes.get(node.id);
    return old ? {...node,name:old.name,notes:old.notes,tags:old.tags,visible:old.visible,locked:old.locked} : node;
  });
  next.connections = next.connections.map(edge => ({...edge,notes:edges.get(edge.id)?.notes??edge.notes}));
  return next;
}
function isUneditedGeneratedProject(map: SemanticMapFile): boolean {
  return map.model.source === "generated" && Object.keys(map.objects ?? {}).length === 0
    && map.calibration.scale === 1 && [...map.calibration.position,...map.calibration.rotation].every(value=>value===0);
}
export function isDefaultSimulationProject(map: SemanticMapFile): boolean {
  return isUneditedGeneratedProject(map)
    && geometrySignature(map) === templateSignature;
}
