import { Html, Line, RoundedBox } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useMapperStore } from "../store";
import {
  BLUE_END_TOWER_CENTER,
  BLUE_ROOM_BAYS,
  BLUE_WING_CENTER,
  BLUE_WING_LENGTH,
  CENTRAL_STAIR_ACCESS_LANDING_DEPTH,
  STAIR_ACCESS_MIN_Z,
  STAIR_ACCESS_MAX_Z,
  CORE_LIFT_X,
  CORE_LIFT_Z,
  CORE_LIFT_SIZE,
  CENTRAL_STAIR_ACCESS_LANDING_WIDTH,
  CENTRAL_STAIR_FLOOR_OPENING_SIZE,
  CORE_CURVED_CANTILEVER_RADIUS,
  CORE_CURVED_STRUCTURAL_RADIUS,
  CLASSROOM_CAPACITY,
  CLASSROOMS,
  CORRIDOR_WIDTH,
  FIELD_CENTER,
  FLOOR_COUNT,
  FLOOR_HEIGHT,
  FULL_BUILDING_CAPACITY,
  ROOMS_PER_UPPER_FLOOR,
  PINK_END_TOWER_CENTER,
  PINK_ROOM_BAYS,
  PINK_WING_CENTER,
  PINK_WING_LENGTH,
  ROOM_DEPTH,
  ROOM_MODULE,
  ROOM_MODULES,
  SLAB_THICKNESS,
  STAIR_FLIGHT_WIDTH,
  STAIR_EXIT_DOOR_CENTERS,
  STAIR_EXIT_DOOR_HEIGHT,
  STAIR_EXIT_DOOR_WIDTH,
  STAIR_FLOOR_OPENING_SIZE,
  STAIR_FIRST_STEP_Z,
  STAIR_FLIGHT_CENTER_OFFSET,
  STAIR_LANDING_DEPTH,
  STAIR_MID_LANDING_Z,
  STAIR_RISER,
  STAIR_SECOND_STEP_Z,
  STAIR_STEPS_PER_FLIGHT,
  STAIR_TREAD,
  STAIR_ZONE_CENTERS,
  TARGET_POPULATION,
  TOTAL_HEIGHT,
  WING_DEPTH,
  blueRoomCenter,
  floorBase,
  pinkRoomCenter,
  type RoomModuleDefinition,
  type StairZone,
  type WingSide,
} from "./building1Data";
import { useBuilding1Store, type BuildingViewMode } from "./building1Store";
import { SportsFieldModel } from "./SportsFieldModel";
import { useEvacuationStore } from "../simulation/simulationStore";
import { CampusLandscape } from "../components/CampusLandscape";
import { createStudentGeometry } from "../simulation/studentGeometry";
import { useQualityStore } from "../rendering/qualityStore";
import { CampusIdentity } from "./CampusIdentity";
import { createClassroomFront, createSchoolChair, createSchoolDesk, createTowerCorner, ROOM_FRONT } from "./architecturalGeometry";
import { ArchitecturalAudit } from "./architecturalAudit";
import { useWalkStore } from "../navigation/walkStore";
import { studentStartPosition } from "../simulation/studentPlacement";

const PINK_BANDS = ["#fff1f7", "#f7daed", "#f0b9df", "#e99bd5", "#e27acb", "#d95dbf", "#cd45b2", "#c036a5", "#ac298f"];
const BLUE_BANDS = ["#edf7ff", "#d0e6f7", "#b1d3ee", "#78c5e8", "#4fb2df", "#779fdf", "#6284d4", "#4c66c6", "#3951ae"];
const WALL = "#eef0ef";
const FRAME = "#e6e8e8";
const GLASS = "#80b8ca";
const FLOOR = "#c7ced0";
const CORRIDOR = "#aeb8bc";
const ROOF_BLUE = "#286d93";
const TOWER_CORNER_GEOMETRY = createTowerCorner(FLOOR_HEIGHT);
const ROOM_FRONT_GEOMETRY = createClassroomFront(ROOM_MODULE, SLAB_THICKNESS, FLOOR_HEIGHT);
const TEACHER_DESK_GEOMETRY = createSchoolDesk(1.7, 0.75);
const CORE_CURVE_THETA_START = -Math.PI / 2;
const CORE_CURVE_THETA_LENGTH = Math.PI / 2;

function visibleFloor(floor: number, mode: BuildingViewMode, selected: number): boolean {
  if (mode === "single-floor" || mode === "interior") return floor === selected;
  if (mode === "cutaway") return floor <= selected;
  return true;
}

function yOffset(floor: number, explode: boolean): number {
  return explode ? (floor - 1) * 1.1 : 0;
}

type WallAxis = "x" | "z";

function StoreyWallFace({
  name,
  axis,
  fixed,
  spanCenter,
  span,
  base,
  opacity,
  doorCenter,
  doorWidth = STAIR_EXIT_DOOR_WIDTH,
  doorHeight = STAIR_EXIT_DOOR_HEIGHT,
}: {
  name: string;
  axis: WallAxis;
  fixed: number;
  spanCenter: number;
  span: number;
  base: number;
  opacity: number;
  doorCenter?: number;
  doorWidth?: number;
  doorHeight?: number;
}) {
  const thickness = 0.28;
  const material = <meshStandardMaterial color="#edf1f0" roughness={0.68} metalness={0.02} transparent={opacity < 0.99} opacity={opacity} depthWrite={opacity > 0.7} />;
  const panel = (key: string, along: number, length: number, y: number, height: number) => {
    if (length <= 0.03 || height <= 0.03) return null;
    return (
      <mesh
        key={key}
        name={`${name}_${key}`}
        position={axis === "x" ? [fixed, y, along] : [along, y, fixed]}
        castShadow={opacity > 0.7}
        receiveShadow
      >
        <boxGeometry args={axis === "x" ? [thickness, height, length] : [length, height, thickness]} />
        {material}
      </mesh>
    );
  };

  if (doorCenter == null) return panel("SOLID", spanCenter, span, base + FLOOR_HEIGHT / 2, FLOOR_HEIGHT);

  const start = spanCenter - span / 2;
  const end = spanCenter + span / 2;
  const openingStart = Math.max(start, doorCenter - doorWidth / 2);
  const openingEnd = Math.min(end, doorCenter + doorWidth / 2);
  const lowerHeight = Math.min(doorHeight, FLOOR_HEIGHT - 0.35);
  return (
    <group name={`${name}_PHYSICAL_DOOR_OPENING`}>
      {panel("LEFT", (start + openingStart) / 2, openingStart - start, base + lowerHeight / 2, lowerHeight)}
      {panel("RIGHT", (openingEnd + end) / 2, end - openingEnd, base + lowerHeight / 2, lowerHeight)}
      {panel("HEADER", spanCenter, span, base + lowerHeight + (FLOOR_HEIGHT - lowerHeight) / 2, FLOOR_HEIGHT - lowerHeight)}
    </group>
  );
}

function SlabWithStairOpening({
  name,
  center,
  size,
  openingCenter,
  y,
  thickness = SLAB_THICKNESS,
}: {
  name: string;
  center: [number, number];
  size: [number, number];
  openingCenter: [number, number];
  y: number;
  thickness?: number;
}) {
  const [cx, cz] = center;
  const [width, depth] = size;
  const [openingWidth, openingDepth] = STAIR_FLOOR_OPENING_SIZE;
  const minX = cx - width / 2;
  const maxX = cx + width / 2;
  const minZ = cz - depth / 2;
  const maxZ = cz + depth / 2;
  const openMinX = Math.max(minX, openingCenter[0] - openingWidth / 2);
  const openMaxX = Math.min(maxX, openingCenter[0] + openingWidth / 2);
  const openMinZ = Math.max(minZ, openingCenter[1] - openingDepth / 2);
  const openMaxZ = Math.min(maxZ, openingCenter[1] + openingDepth / 2);
  const panels = [
    { id: "WEST", x: (minX + openMinX) / 2, z: cz, w: openMinX - minX, d: depth },
    { id: "EAST", x: (openMaxX + maxX) / 2, z: cz, w: maxX - openMaxX, d: depth },
    { id: "SOUTH", x: (openMinX + openMaxX) / 2, z: (minZ + openMinZ) / 2, w: openMaxX - openMinX, d: openMinZ - minZ },
    { id: "NORTH", x: (openMinX + openMaxX) / 2, z: (openMaxZ + maxZ) / 2, w: openMaxX - openMinX, d: maxZ - openMaxZ },
  ];

  return (
    <group name={`${name}_REAL_STAIR_VOID`}>
      {panels.filter((panel) => panel.w > 0.03 && panel.d > 0.03).map((panel) => (
        <mesh key={panel.id} name={`${name}_${panel.id}`} position={[panel.x, y, panel.z]} receiveShadow>
          <boxGeometry args={[panel.w, thickness, panel.d]} />
          <meshStandardMaterial color={FLOOR} roughness={0.82} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Central-core slab with a true quarter-circle courtyard edge. The rectangular
 * stair void remains exact, while the former square projection is removed from
 * every floor (including the roof) instead of being hidden behind a facade.
 */
function CurvedCoreSlab({ name, y, openingCenter, thickness = SLAB_THICKNESS }: {
  name: string; y: number; openingCenter?: [number, number]; thickness?: number;
}) {
  // Trim the junction against the two wing slabs. No overlapping coplanar plates,
  // and no core walls or floors extending into the first blue/pink classroom.
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-3.7, -10);
    shape.lineTo(10, -10);
    shape.lineTo(10, 3.7);
    shape.lineTo(-3.5, 3.7);
    const tangent = Math.sqrt(CORE_CURVED_STRUCTURAL_RADIUS ** 2 - 3.5 ** 2);
    shape.lineTo(-3.5, tangent);
    shape.absarc(0, 0, CORE_CURVED_STRUCTURAL_RADIUS,
      Math.atan2(tangent, -3.5), Math.atan2(3.5, -tangent), false);
    shape.lineTo(-3.7, 3.5);
    shape.closePath();
    if (openingCenter) {
      const [w, d] = CENTRAL_STAIR_FLOOR_OPENING_SIZE;
      const [x, z] = openingCenter;
      const hole = new THREE.Path();
      hole.moveTo(x - w / 2, z - d / 2);
      hole.lineTo(x - w / 2, z + d / 2);
      hole.lineTo(x + w / 2, z + d / 2);
      hole.lineTo(x + w / 2, z - d / 2);
      hole.closePath();
      shape.holes.push(hole);
    }
    const result = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 32 });
    result.rotateX(Math.PI / 2);
    result.translate(0, thickness / 2, 0);
    return result;
  }, [openingCenter?.[0], openingCenter?.[1], thickness]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh name={name + "_CURVED_COURTYARD_EDGE_REAL_STAIR_VOID"} geometry={geometry} position={[0, y, 0]} castShadow receiveShadow>
    <meshStandardMaterial color={FLOOR} roughness={0.82} />
  </mesh>;
}

function createAnnularSectorGeometry(
  innerRadius: number,
  outerRadius: number,
  height: number,
  segments: number,
  thetaStart: number,
  thetaLength: number,
) {
  const positions: number[] = [];
  const halfHeight = height / 2;
  const point = (radius: number, angle: number, y: number): [number, number, number] => [
    radius * Math.sin(angle),
    y,
    radius * Math.cos(angle),
  ];
  const triangle = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ) => positions.push(...a, ...b, ...c);

  for (let index = 0; index < segments; index += 1) {
    const angleA = thetaStart + thetaLength * (index / segments);
    const angleB = thetaStart + thetaLength * ((index + 1) / segments);
    const outerBottomA = point(outerRadius, angleA, -halfHeight);
    const outerBottomB = point(outerRadius, angleB, -halfHeight);
    const outerTopA = point(outerRadius, angleA, halfHeight);
    const outerTopB = point(outerRadius, angleB, halfHeight);
    const innerBottomA = point(innerRadius, angleA, -halfHeight);
    const innerBottomB = point(innerRadius, angleB, -halfHeight);
    const innerTopA = point(innerRadius, angleA, halfHeight);
    const innerTopB = point(innerRadius, angleB, halfHeight);

    // Finished top and soffit.
    triangle(outerTopA, outerTopB, innerTopB);
    triangle(outerTopA, innerTopB, innerTopA);
    triangle(outerBottomA, innerBottomB, outerBottomB);
    triangle(outerBottomA, innerBottomA, innerBottomB);
    // Curved outer fascia and the hidden inner return.
    triangle(outerBottomA, outerBottomB, outerTopB);
    triangle(outerBottomA, outerTopB, outerTopA);
    triangle(innerBottomA, innerTopB, innerBottomB);
    triangle(innerBottomA, innerTopA, innerTopB);

    if (index === 0) {
      triangle(innerBottomA, outerBottomA, outerTopA);
      triangle(innerBottomA, outerTopA, innerTopA);
    }
    if (index === segments - 1) {
      triangle(innerBottomB, outerTopB, outerBottomB);
      triangle(innerBottomB, innerTopB, outerTopB);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const CORE_CURVED_CANTILEVER_GEOMETRY = createAnnularSectorGeometry(
  CORE_CURVED_STRUCTURAL_RADIUS,
  CORE_CURVED_CANTILEVER_RADIUS,
  0.18,
  64,
  CORE_CURVE_THETA_START,
  CORE_CURVE_THETA_LENGTH,
);

/**
 * Shallow exterior-only annular cantilever below the structural slab. Its
 * inner radius starts exactly at the structural edge, so no hidden mesh enters
 * the school interior. A 6 mm vertical reveal prevents coplanar flicker while
 * the stair opening, lift bank, rooms, and evacuation graph remain untouched.
 */
function CurvedCoreCantilever({ name, slabCenterY }: { name: string; slabCenterY: number }) {
  const thickness = 0.18;
  const topY = slabCenterY + SLAB_THICKNESS / 2 - 0.006;
  const centerY = topY - thickness / 2;
  return (
    <group name={`${name}_NON_NAVIGABLE_EXTERIOR`}>
      <mesh name={`${name}_PROJECTION`} position={[0, centerY, 0]} castShadow receiveShadow>
        <primitive attach="geometry" object={CORE_CURVED_CANTILEVER_GEOMETRY} />
        <meshStandardMaterial color="#d9e0e1" roughness={0.76} />
      </mesh>
      <mesh name={`${name}_CURVED_FASCIA`} position={[0, slabCenterY - 0.025, 0]} castShadow receiveShadow>
        <cylinderGeometry
          args={[CORE_CURVED_CANTILEVER_RADIUS - 0.025, CORE_CURVED_CANTILEVER_RADIUS - 0.025, 0.3, 64, 1, true, CORE_CURVE_THETA_START, CORE_CURVE_THETA_LENGTH]}
        />
        <meshStandardMaterial color="#eef2f1" roughness={0.66} metalness={0.025} side={THREE.DoubleSide} />
      </mesh>
      <mesh name={`${name}_DRIP_EDGE`} position={[0, slabCenterY - 0.145, 0]}>
        <cylinderGeometry
          args={[CORE_CURVED_CANTILEVER_RADIUS + 0.018, CORE_CURVED_CANTILEVER_RADIUS + 0.018, 0.055, 64, 1, true, CORE_CURVE_THETA_START, CORE_CURVE_THETA_LENGTH]}
        />
        <meshStandardMaterial color="#8199a1" roughness={0.48} metalness={0.12} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function CurvedCoreOpenRailing({ name, deckY, color = "#edf4f4" }: { name: string; deckY: number; color?: string }) {
  const radius = CORE_CURVED_CANTILEVER_RADIUS - 0.16;
  // Keep the guard rail exclusively on the exposed courtyard nose. The former
  // full 90-degree arc continued past both courtyard faces and visually cut
  // through the pink/blue interior corridors. These endpoints are derived
  // from the real wing envelopes, with a small exterior clearance so neither
  // rail tubes nor posts can enter the school interior.
  const courtyardWingClearance = 0.18;
  const pinkCourtyardEdgeZ = PINK_WING_CENTER[2] + WING_DEPTH / 2;
  const blueCourtyardEdgeX = BLUE_WING_CENTER[0] - WING_DEPTH / 2;
  const railStartAngle = -Math.acos(Math.min(1, (pinkCourtyardEdgeZ + courtyardWingClearance) / radius));
  const railEndAngle = Math.asin(Math.max(-1, (blueCourtyardEdgeX - courtyardWingClearance) / radius));
  const railAngleLength = Math.max(0.1, railEndAngle - railStartAngle);
  const arc = useMemo(() => new THREE.CatmullRomCurve3(
    Array.from({ length: 33 }, (_, index) => {
      const angle = railStartAngle + railAngleLength * (index / 32);
      return new THREE.Vector3(radius * Math.sin(angle), 0, radius * Math.cos(angle));
    }),
    false,
    "centripetal",
  ), [radius, railAngleLength, railStartAngle]);
  const postCount = Math.max(3, Math.ceil((radius * railAngleLength) / 0.82) + 1);
  const postAngles = Array.from({ length: postCount }, (_, index) => (
    railStartAngle + railAngleLength * (index / (postCount - 1))
  ));
  return (
    <group name={`${name}_OPEN_BALCONY_NO_WALL`} position={[0, deckY, 0]}>
      {[0.52, 1.02].map((height) => (
        <mesh key={height} name={`${name}_CURVED_RAIL_${height}`} position={[0, height, 0]} castShadow>
          <tubeGeometry args={[arc, 48, 0.035, 8, false]} />
          <meshStandardMaterial color={color} metalness={0.48} roughness={0.34} />
        </mesh>
      ))}
      {postAngles.map((angle, index) => (
        <mesh
          key={angle}
          name={`${name}_RAIL_POST_${index + 1}`}
          position={[radius * Math.sin(angle), 0.52, radius * Math.cos(angle)]}
          castShadow
        >
          <cylinderGeometry args={[0.035, 0.035, 1.04, 8]} />
          <meshStandardMaterial color={color} metalness={0.48} roughness={0.34} />
        </mesh>
      ))}
    </group>
  );
}


function SectionLabel({ text, position }: { text: string; position: [number, number, number] }) {
  return (
    <Html center position={position} distanceFactor={18}>
      <div className="room-world-label"><strong>{text}</strong></div>
    </Html>
  );
}

function DoorLeaf({
  name,
  position,
  rotation = [0, 0, 0],
  color = "#8d6e52",
  evacuationPortal = true,
  reducedDetail = false,
}: {
  name: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
  evacuationPortal?: boolean;
  reducedDetail?: boolean;
}) {
  const showDoors = useBuilding1Store((state) => state.showDoors);
  const workMode = useEvacuationStore((state) => state.workMode);
  const simulationStatus = useEvacuationStore((state) => state.status);
  const walking = useWalkStore((state) => state.enabled);
  const hingeRef = useRef<THREE.Group | null>(null);
  const openForEvacuation = evacuationPortal && workMode === "simulation" && (simulationStatus !== "idle" || walking);
  const initiallyOpen = useRef(openForEvacuation);
  useFrame((_, delta) => {
    if (!hingeRef.current) return;
    // Fold the leaf almost flat against the adjacent wall. A 90-degree leaf still
    // projects into the evacuation lane and can visually intersect an agent.
    const target = openForEvacuation ? -Math.PI * 0.96 : 0;
    if (Math.abs(hingeRef.current.rotation.y - target) < 0.004) { hingeRef.current.rotation.y = target; return; }
    hingeRef.current.rotation.y = THREE.MathUtils.damp(hingeRef.current.rotation.y, target, 12, delta);
  });
  if (!showDoors) return null;
  return (
    <group name={name} position={position} rotation={rotation}>
      {/* Three-piece frame only. There is deliberately no backing panel inside the doorway. */}
      {[-0.57, 0.57].map((x) => (
        <mesh key={x} position={[x, -0.035, -0.07]}>
          <boxGeometry args={[0.1, 2.31, 0.14]} />
          <meshStandardMaterial color={FRAME} roughness={0.6} />
        </mesh>
      ))}
      <mesh position={[0, 1.19, -0.07]}>
        <boxGeometry args={[1.24, 0.14, 0.14]} />
        <meshStandardMaterial color={FRAME} roughness={0.6} />
      </mesh>
      <group ref={hingeRef} position={[-0.51, 0, 0.05]} rotation-y={initiallyOpen.current ? -Math.PI * 0.96 : 0}>
        <mesh position={[0.51, -0.04, 0]}>
          <boxGeometry args={[1.02, 2.26, 0.09]} />
          <meshStandardMaterial color={color} roughness={0.58} />
        </mesh>
        {!reducedDetail && <mesh position={[0.78, 0, 0.07]}>
          <sphereGeometry args={[0.055, 10, 10]} />
          <meshStandardMaterial color="#d8b65f" metalness={0.75} roughness={0.25} />
        </mesh>}
      </group>
      {openForEvacuation && !reducedDetail && (
        <mesh position={[0, 1.38, 0.12]}>
          <boxGeometry args={[0.76, 0.18, 0.04]} />
          <meshStandardMaterial color="#2ea56f" emissive="#1c7d53" emissiveIntensity={0.18} roughness={0.5} />
        </mesh>
      )}
    </group>
  );
}

interface StaticBoxBatchStats {
  sourceMeshes: number;
  batchDraws: number;
  savedDraws: number;
  remainingRenderables: number;
  transparentMeshes: number;
  remainingTypes: Record<string, number>;
}

function opaqueMaterialBatchKey(material: THREE.Material, castShadow: boolean, receiveShadow: boolean): string | null {
  const standard = material as THREE.MeshStandardMaterial;
  const physical = material as THREE.MeshPhysicalMaterial;
  const opaque = !standard.transparent && standard.opacity >= 0.999;
  // Window panes in this model write depth and never overlap one another. They are safe to
  // instance without transparent sort flicker; smoke/transmission materials stay unbatched.
  const stableArchitecturalGlass = standard.transparent && standard.depthWrite && standard.opacity >= 0.5;
  if (
    !standard.isMeshStandardMaterial
    || (!opaque && !stableArchitecturalGlass)
    || (physical.isMeshPhysicalMaterial && physical.transmission > 0)
    || standard.map != null
    || standard.blending !== THREE.NormalBlending
    || standard.alphaTest > 0
    || standard.vertexColors
  ) return null;
  return [
    standard.type,
    standard.color.getHexString(),
    standard.roughness.toFixed(4),
    standard.metalness.toFixed(4),
    standard.emissive.getHexString(),
    standard.emissiveIntensity.toFixed(4),
    Number(standard.transparent),
    standard.opacity.toFixed(4),
    standard.side,
    Number(standard.depthTest),
    Number(standard.depthWrite),
    Number(standard.toneMapped),
    Number(castShadow),
    Number(receiveShadow),
  ].join("|");
}

function staticGeometryFingerprint(geometry: THREE.BufferGeometry): string | null {
  if (geometry.type !== "ExtrudeGeometry") return null;
  const position = geometry.getAttribute("position");
  if (!position || !ArrayBuffer.isView(position.array)) return null;
  const values = position.array as unknown as ArrayLike<number>;
  let hash = 2166136261;
  for (let index = 0; index < values.length; index += 1) {
    const quantized = Math.round(Number(values[index]) * 100_000);
    hash ^= quantized;
    hash = Math.imul(hash, 16777619);
  }
  return `${geometry.type}|${position.count}|${geometry.getIndex()?.count ?? 0}|${hash >>> 0}`;
}

/**
 * Collapses repeated opaque BoxGeometry pieces into a few GPU instanced draws in Simulation.
 * Source meshes stay mounted (but hidden), so React state, the editor, and dynamic doors remain intact.
 */
function StaticBoxBatcher({ rootRef, enabled }: { rootRef: React.RefObject<THREE.Group | null>; enabled: boolean }) {
  const gl = useThree((state) => state.gl);
  const simulationDoorsOpen = useEvacuationStore((state) => state.status !== "idle");
  const walking = useWalkStore((state) => state.enabled);
  const doorsOpen = simulationDoorsOpen || walking;
  const previousDoorsOpen = useRef(doorsOpen);
  const doorsSettleAt = useRef(0);
  const tier = useQualityStore((state) => state.tier);
  const viewSignature = useBuilding1Store((state) => [state.viewMode, state.selectedFloor, state.explodeFloors,
    state.showRoof, state.showInteriorWalls, state.showDoors, state.showFacadeWindows, state.showStairs,
    state.showLiftCore, state.showCorridorLights, state.showSportsField, state.showTrackLanes,
    state.showFootballMarkings, state.showGoals, state.showAssemblyZones, state.showFieldLights,
    state.showFurniture].join("|"));

  useEffect(() => {
    const root = rootRef.current;
    const doorTransition = previousDoorsOpen.current !== doorsOpen;
    previousDoorsOpen.current = doorsOpen;
    if (doorTransition) doorsSettleAt.current = performance.now() + 560;
    if (!enabled || !root) {
      const emptyStats = {
        sourceMeshes: 0,
        batchDraws: 0,
        savedDraws: 0,
        remainingRenderables: 0,
        transparentMeshes: 0,
        remainingTypes: {},
      };
      (window as Window & { __SKR_STATIC_BATCH__?: StaticBoxBatchStats }).__SKR_STATIC_BATCH__ = emptyStats;
      gl.domElement.dataset.skrStaticBatch = JSON.stringify(emptyStats);
      return;
    }

    let disposed = false;
    let batchRoot: THREE.Group | null = null;
    const hiddenSources: THREE.Mesh[] = [];
    const originalRaycasts = new Map<THREE.Mesh, THREE.Mesh["raycast"]>();
    const originalMatrixUpdates = new Map<THREE.Mesh, boolean>();
    const ownedMaterials: THREE.Material[] = [];
    const ownedGeometries: THREE.BufferGeometry[] = [];
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitPlane = new THREE.PlaneGeometry(1, 1);
    // Let animated doors reach their new open/closed pose, then freeze that final pose into
    // the instanced batches. During the short transition the original door meshes stay visible.
    const buildBatches = () => {
      if (disposed || !rootRef.current) return;
      root.updateWorldMatrix(true, true);
      const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
      const groups = new Map<string, {
        material: THREE.MeshStandardMaterial;
        geometry: THREE.BufferGeometry;
        castShadow: boolean;
        receiveShadow: boolean;
        sources: THREE.Mesh[];
        matrices: THREE.Matrix4[];
      }>();

      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (
          !mesh.isMesh
          || (mesh as THREE.InstancedMesh).isInstancedMesh
          || !mesh.visible
          || Array.isArray(mesh.material)
        ) return;
        for (let ancestor = mesh.parent; ancestor && ancestor !== root; ancestor = ancestor.parent) {
          if (!ancestor.visible) return;
        }
        const materialKey = opaqueMaterialBatchKey(mesh.material, mesh.castShadow, mesh.receiveShadow);
        if (!materialKey) return;
        const parameters = (mesh.geometry as THREE.BufferGeometry & { parameters?: Record<string, unknown> }).parameters;
        let geometryKey = "";
        let batchGeometry: THREE.BufferGeometry | null = null;
        const geometryScale = new THREE.Vector3(1, 1, 1);
        if (mesh.geometry.type === "BoxGeometry" && parameters) {
          geometryKey = "UNIT_BOX";
          batchGeometry = unitBox;
          geometryScale.set(
            Number(parameters.width ?? 1),
            Number(parameters.height ?? 1),
            Number(parameters.depth ?? 1),
          );
        } else if (mesh.geometry.type === "PlaneGeometry" && parameters) {
          geometryKey = "UNIT_PLANE";
          batchGeometry = unitPlane;
          geometryScale.set(Number(parameters.width ?? 1), Number(parameters.height ?? 1), 1);
        } else if (["CylinderGeometry", "SphereGeometry", "CircleGeometry"].includes(mesh.geometry.type) && parameters) {
          geometryKey = `${mesh.geometry.type}|${JSON.stringify(parameters)}`;
        } else {
          const fingerprint = staticGeometryFingerprint(mesh.geometry);
          if (!fingerprint) return;
          geometryKey = fingerprint;
        }
        const groupKey = `${materialKey}|${geometryKey}`;
        mesh.updateWorldMatrix(true, false);
        const localMatrix = new THREE.Matrix4()
          .multiplyMatrices(inverseRoot, mesh.matrixWorld)
          .multiply(new THREE.Matrix4().makeScale(geometryScale.x, geometryScale.y, geometryScale.z));
        let entry = groups.get(groupKey);
        if (!entry) {
          if (!batchGeometry) {
            batchGeometry = mesh.geometry.clone();
            ownedGeometries.push(batchGeometry);
          }
          entry = {
          material: mesh.material as THREE.MeshStandardMaterial,
          geometry: batchGeometry,
          castShadow: mesh.castShadow,
          receiveShadow: mesh.receiveShadow,
          sources: [],
          matrices: [],
          };
        }
        entry.sources.push(mesh);
        entry.matrices.push(localMatrix);
        groups.set(groupKey, entry);
      });

      batchRoot = new THREE.Group();
      batchRoot.name = "B1_STATIC_GPU_BATCHES";
      batchRoot.matrixAutoUpdate = false;
      let sourceMeshes = 0;
      let batchDraws = 0;
      groups.forEach((entry, key) => {
        if (entry.sources.length < 2) return;
        const material = entry.material.clone();
        ownedMaterials.push(material);
        const batch = new THREE.InstancedMesh(entry.geometry, material, entry.matrices.length);
        batch.name = `B1_GPU_BATCH_${batchDraws + 1}`;
        batch.castShadow = entry.castShadow;
        batch.receiveShadow = entry.receiveShadow;
        batch.userData.performanceBatch = true;
        batch.matrixAutoUpdate = false;
        batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        entry.matrices.forEach((matrix, index) => batch.setMatrixAt(index, matrix));
        batch.instanceMatrix.needsUpdate = true;
        batch.computeBoundingBox();
        batch.computeBoundingSphere();
        batchRoot?.add(batch);
        entry.sources.forEach((source) => {
          originalRaycasts.set(source, source.raycast);
          originalMatrixUpdates.set(source, source.matrixAutoUpdate);
          source.matrixAutoUpdate = false;
          source.raycast = () => {};
          source.visible = false;
          hiddenSources.push(source);
        });
        sourceMeshes += entry.sources.length;
        batchDraws += 1;
        void key;
      });
      root.add(batchRoot);
      let remainingRenderables = 0;
      let transparentMeshes = 0;
      const remainingTypes: Record<string, number> = {};
      root.traverse((object) => {
        const renderable = object as THREE.Mesh;
        if (!object.visible || (!renderable.isMesh && !(object as THREE.Line).isLine && !(object as THREE.Points).isPoints)) return;
        remainingRenderables += 1;
        const type = renderable.isMesh ? renderable.geometry.type : object.type;
        remainingTypes[type] = (remainingTypes[type] ?? 0) + 1;
        if (renderable.isMesh && !Array.isArray(renderable.material) && renderable.material.transparent) transparentMeshes += 1;
      });
      gl.shadowMap.needsUpdate = true;
      const batchStats = {
        sourceMeshes,
        batchDraws,
        savedDraws: Math.max(0, sourceMeshes - batchDraws),
        remainingRenderables,
        transparentMeshes,
        remainingTypes,
      };
      (window as Window & { __SKR_STATIC_BATCH__?: StaticBoxBatchStats }).__SKR_STATIC_BATCH__ = batchStats;
      gl.domElement.dataset.skrStaticBatch = JSON.stringify(batchStats);
    };
    // The parent group ref is attached after child layout effects. Run after commit so a
    // fresh mount always batches the complete tree, including on mobile quality changes.
    let settleTimer = 0;
    const settleDelay = Math.max(0, doorsSettleAt.current - performance.now());
    if (settleDelay > 0) settleTimer = window.setTimeout(buildBatches, settleDelay);
    else queueMicrotask(buildBatches);

    return () => {
      disposed = true;
      window.clearTimeout(settleTimer);
      hiddenSources.forEach((mesh) => {
        mesh.visible = true;
        mesh.raycast = originalRaycasts.get(mesh)!;
        mesh.matrixAutoUpdate = originalMatrixUpdates.get(mesh)!;
      });
      if (batchRoot?.parent) batchRoot.parent.remove(batchRoot);
      ownedMaterials.forEach((material) => material.dispose());
      ownedGeometries.forEach((geometry) => geometry.dispose());
      unitBox.dispose();
      unitPlane.dispose();
      gl.shadowMap.needsUpdate = true;
    };
  }, [enabled, gl, rootRef, doorsOpen, tier, viewSignature]);

  return null;
}

function PhysicalRailSegment({ start, end, color }: {
  start: [number, number, number];
  end: [number, number, number];
  color: string;
}) {
  const transform = useMemo(() => {
    const from = new THREE.Vector3(...start);
    const to = new THREE.Vector3(...end);
    const direction = to.clone().sub(from);
    const length = direction.length();
    return {
      midpoint: from.add(to).multiplyScalar(0.5),
      rotation: new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.normalize(),
      ),
      length,
    };
  }, [end, start]);
  return (
    <mesh position={transform.midpoint} quaternion={transform.rotation}>
      <cylinderGeometry args={[0.045, 0.045, transform.length, 8]} />
      <meshStandardMaterial color={color} metalness={0.5} roughness={0.3} />
    </mesh>
  );
}

function WindowStrip({
  name,
  position,
  size,
  rotation = [0, 0, 0],
  divisions = 4,
  reducedDetail = false,
  framed = false,
}: {
  name: string;
  position: [number, number, number];
  size: [number, number, number];
  rotation?: [number, number, number];
  divisions?: number;
  reducedDetail?: boolean;
  framed?: boolean;
}) {
  const show = useBuilding1Store((state) => state.showFacadeWindows);
  if (!show) return null;
  const horizontal = size[0] >= size[2];
  const glassSize: [number, number, number] = framed ? [size[0] - 0.12, size[1] - 0.12, size[2]] : size;
  return (
    <group name={name} position={position} rotation={rotation}>
      <mesh>
        <boxGeometry args={glassSize} />
        <meshStandardMaterial color={GLASS} transparent opacity={0.72} roughness={0.2} metalness={0.08} />
      </mesh>
      {framed && <>
        {[-1, 1].map((side) => (
          <mesh key={`jamb-${side}`} position={[side * (size[0] / 2 - 0.02), 0, 0]}>
            <boxGeometry args={[0.08, size[1] + 0.04, 0.16]} />
            <meshStandardMaterial color={FRAME} roughness={0.6} />
          </mesh>
        ))}
        {[-1, 1].map((side) => (
          <mesh key={`rail-${side}`} position={[0, side * (size[1] / 2 - 0.02), 0]}>
            <boxGeometry args={[size[0] - 0.12, 0.08, 0.16]} />
            <meshStandardMaterial color={FRAME} roughness={0.6} />
          </mesh>
        ))}
      </>}
      {!reducedDetail && Array.from({ length: divisions - 1 }, (_, index) => {
        const fraction = (index + 1) / divisions - 0.5;
        return (
          <mesh
            key={index}
            position={framed ? [fraction * glassSize[0], 0, 0] : horizontal ? [fraction * size[0], 0, size[2] * 0.6] : [size[0] * 0.6, 0, fraction * size[2]]}
          >
            <boxGeometry args={framed ? [0.055, glassSize[1], 0.14] : horizontal ? [0.055, size[1] + 0.12, 0.06] : [0.06, size[1] + 0.12, 0.055]} />
            <meshStandardMaterial color="#f2f4f4" roughness={0.7} />
          </mesh>
        );
      })}
    </group>
  );
}

function ClassroomFront({ floor, index, y, reducedDetail, wing }: {
  floor: number; index: number; y: number; reducedDetail: boolean; wing: "PINK" | "BLUE";
}) {
  const showWalls = useBuilding1Store((state) => state.showInteriorWalls);
  if (!showWalls) return null;
  const pink = wing === "PINK";
  const position: [number, number, number] = pink
    ? [pinkRoomCenter(index)[0], y, 0.12]
    : [0.12, y, blueRoomCenter(index)[2]];
  return (
    <group name={`B1_F${floor}_${wing}_ROOM_FRONT_${index + 1}`} position={position} rotation-y={pink ? 0 : -Math.PI / 2}>
      <mesh name={`B1_${wing}_ROOM_WALL_F${floor}_${index}`} geometry={ROOM_FRONT_GEOMETRY} dispose={null}>
        <meshStandardMaterial color={WALL} roughness={0.76} />
      </mesh>
      <DoorLeaf
        name={`B1_F${floor}_${wing}_DOOR_${index + 1}`}
        position={[ROOM_FRONT.doorX, SLAB_THICKNESS + 1.19, 0.11]}
        reducedDetail={reducedDetail}
      />
      <WindowStrip
        name={`B1_F${floor}_${wing}_CORRIDOR_WINDOW_${index + 1}`}
        position={[ROOM_FRONT.windowX, (ROOM_FRONT.windowBottom + ROOM_FRONT.windowTop) / 2, 0.04]}
        size={[ROOM_FRONT.windowWidth, ROOM_FRONT.windowTop - ROOM_FRONT.windowBottom, 0.05]}
        divisions={4}
        reducedDetail={reducedDetail}
        framed
      />
    </group>
  );
}

function PinkRoomFront(props: { floor: number; index: number; y: number; reducedDetail: boolean }) {
  return <ClassroomFront {...props} wing="PINK" />;
}

function BlueRoomFront(props: { floor: number; index: number; y: number; reducedDetail: boolean }) {
  return <ClassroomFront {...props} wing="BLUE" />;
}

// The parapet starts at the finished floor; posts terminate inside the edge beam.
// A shared section keeps both wings attached to the same slab and ceiling edges.
function CorridorBalustrade({ floor, wing, base, band }: {
  floor: number; wing: "PINK" | "BLUE"; base: number; band: string;
}) {
  const pink = wing === "PINK";
  const length = pink ? PINK_WING_LENGTH : BLUE_WING_LENGTH;
  const position: [number, number, number] = pink
    ? [PINK_WING_CENTER[0], base, 3.58]
    : [-3.58, base, BLUE_WING_CENTER[2]];
  const parapetTop = SLAB_THICKNESS + 1.1;
  return <group name={`B1_${wing}_F${floor}_CORRIDOR_EDGE`} position={position} rotation-y={pink ? 0 : -Math.PI / 2}>
    <mesh name={`B1_${wing}_F${floor}_FACADE_BAND`} position={[0, (SLAB_THICKNESS + parapetTop) / 2, 0]}>
      <boxGeometry args={[length, parapetTop - SLAB_THICKNESS, 0.2]} />
      <meshStandardMaterial color={band} roughness={0.62} />
    </mesh>
    <mesh name={`B1_${wing}_F${floor}_EDGE_BEAM`} position={[0, 3.25, 0]}>
      <boxGeometry args={[length, 0.5, 0.24]} />
      <meshStandardMaterial color={WALL} roughness={0.76} />
    </mesh>
    <mesh position={[0, 2.45, 0]}>
      <boxGeometry args={[length, 0.12, 0.14]} />
      <meshStandardMaterial color="#f4f5f4" roughness={0.65} />
    </mesh>
    {Array.from({ length: length / 4 + 1 }, (_, index) => (
      <mesh key={index} position={[-length / 2 + index * 4, (parapetTop + 3.04) / 2, 0]}>
        <boxGeometry args={[0.1, 3.04 - parapetTop, 0.14]} />
        <meshStandardMaterial color="#f4f5f4" roughness={0.68} />
      </mesh>
    ))}
  </group>;
}

function PinkWingFloor({ floor }: { floor: number }) {
  const reducedDetail = useQualityStore((state) => state.tier === "economy");
  const mode = useBuilding1Store((state) => state.viewMode);
  const selected = useBuilding1Store((state) => state.selectedFloor);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  const showWalls = useBuilding1Store((state) => state.showInteriorWalls);
  const showWindows = useBuilding1Store((state) => state.showFacadeWindows);
  const showLights = useBuilding1Store((state) => state.showCorridorLights);
  if (!visibleFloor(floor, mode, selected)) return null;

  const base = floorBase(floor) + yOffset(floor, explode);
  const structureOnly = mode === "structure";
  const hideOuterWall = mode === "interior" || mode === "single-floor";
  const band = PINK_BANDS[floor - 1];

  return (
    <group name={`B1_PINK_WING_F${floor}`}>
      <mesh name={`B1_PINK_F${floor}_SLAB`} position={[PINK_WING_CENTER[0], base + SLAB_THICKNESS / 2, PINK_WING_CENTER[2] + 0.1]} receiveShadow>
        <boxGeometry args={[PINK_WING_LENGTH + 0.6, SLAB_THICKNESS, WING_DEPTH + 0.2]} />
        <meshStandardMaterial color={FLOOR} roughness={0.82} />
      </mesh>
      <mesh name={`B1_PINK_F${floor}_CORRIDOR_FLOOR`} position={[PINK_WING_CENTER[0], base + 0.17, 1.9]}>
        <boxGeometry args={[PINK_WING_LENGTH, 0.1, CORRIDOR_WIDTH]} />
        <meshStandardMaterial color={CORRIDOR} roughness={0.88} />
      </mesh>

      {floor === 1 ? (
        <>
          {Array.from({ length: PINK_ROOM_BAYS * 2 + 1 }, (_, index) => (
            <mesh key={index} name={`B1_PINK_GROUND_COLUMN_${index + 1}`} position={[-4 - index * 4, base + 1.72, 1.4]} castShadow>
              <cylinderGeometry args={[0.23, 0.23, 3.35, 14]} />
              <meshStandardMaterial color="#e9ebea" roughness={0.75} />
            </mesh>
          ))}
          <mesh position={[PINK_WING_CENTER[0], base + 0.08, -4.5]}>
            <boxGeometry args={[PINK_WING_LENGTH, 0.12, 8.7]} />
            <meshStandardMaterial color="#bbc1c2" roughness={0.9} />
          </mesh>
        </>
      ) : (
        <>
          {!structureOnly && (!hideOuterWall || showWalls) && (
            <>
              <mesh name={`B1_PINK_F${floor}_OUTER_WALL`} position={[PINK_WING_CENTER[0], base + 1.72, -9.88]}>
                <boxGeometry args={[PINK_WING_LENGTH, 3.18, 0.22]} />
                <meshStandardMaterial color={WALL} roughness={0.75} />
              </mesh>
              {showWindows && !hideOuterWall && Array.from({ length: PINK_ROOM_BAYS }, (_, index) => (
                <WindowStrip
                  key={index}
                  name={`B1_PINK_F${floor}_OUTER_WINDOW_${index + 1}`}
                  position={[pinkRoomCenter(index)[0], base + 1.75, -10.02]}
                  size={[6.35, 1.5, 0.08]}
                  divisions={4}
                  reducedDetail={reducedDetail}
                />
              ))}
            </>
          )}

          {!structureOnly && (
            <>
              {Array.from({ length: PINK_ROOM_BAYS }, (_, index) => (
                <PinkRoomFront key={index} floor={floor} index={index} y={base} reducedDetail={reducedDetail} />
              ))}
              {showWalls && Array.from({ length: PINK_ROOM_BAYS + 1 }, (_, index) => (
                <mesh key={index} name={`B1_PINK_F${floor}_PARTITION_${index}`} position={[-4 - index * ROOM_MODULE, base + 1.87, -4.83]}>
                  <boxGeometry args={[0.16, 3.26, ROOM_DEPTH + 0.14]} />
                  <meshStandardMaterial color={WALL} roughness={0.78} />
                </mesh>
              ))}
            </>
          )}

          {!structureOnly && <CorridorBalustrade floor={floor} wing="PINK" base={base} band={band} />}
        </>
      )}
      {showLights && !structureOnly && !reducedDetail && (
        <group name={`B1_PINK_F${floor}_CORRIDOR_LIGHTS`}>
          {Array.from({ length: PINK_ROOM_BAYS * 2 }, (_, index) => (
            <mesh key={index} position={[-6 - index * 4, base + 3.18, 1.95]}>
              <boxGeometry args={[1.15, 0.06, 0.22]} />
              <meshStandardMaterial color="#f8fdff" emissive="#d8f4ff" emissiveIntensity={1.4} roughness={0.35} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}

function BlueWingFloor({ floor }: { floor: number }) {
  const reducedDetail = useQualityStore((state) => state.tier === "economy");
  const mode = useBuilding1Store((state) => state.viewMode);
  const selected = useBuilding1Store((state) => state.selectedFloor);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  const showWalls = useBuilding1Store((state) => state.showInteriorWalls);
  const showWindows = useBuilding1Store((state) => state.showFacadeWindows);
  const showLights = useBuilding1Store((state) => state.showCorridorLights);
  if (!visibleFloor(floor, mode, selected)) return null;

  const base = floorBase(floor) + yOffset(floor, explode);
  const structureOnly = mode === "structure";
  const hideOuterWall = mode === "interior" || mode === "single-floor";
  const band = BLUE_BANDS[floor - 1];

  return (
    <group name={`B1_BLUE_WING_F${floor}`}>
      <mesh name={`B1_BLUE_F${floor}_SLAB`} position={[BLUE_WING_CENTER[0] - 0.1, base + SLAB_THICKNESS / 2, BLUE_WING_CENTER[2]]} receiveShadow>
        <boxGeometry args={[WING_DEPTH + 0.2, SLAB_THICKNESS, BLUE_WING_LENGTH + 0.6]} />
        <meshStandardMaterial color={FLOOR} roughness={0.82} />
      </mesh>
      <mesh name={`B1_BLUE_F${floor}_CORRIDOR_FLOOR`} position={[-1.9, base + 0.17, BLUE_WING_CENTER[2]]}>
        <boxGeometry args={[CORRIDOR_WIDTH, 0.1, BLUE_WING_LENGTH]} />
        <meshStandardMaterial color={CORRIDOR} roughness={0.88} />
      </mesh>

      {floor === 1 ? (
        <>
          {Array.from({ length: BLUE_ROOM_BAYS * 2 + 1 }, (_, index) => (
            <mesh key={index} name={`B1_BLUE_GROUND_COLUMN_${index + 1}`} position={[-1.4, base + 1.72, 4 + index * 4]} castShadow>
              <cylinderGeometry args={[0.23, 0.23, 3.35, 14]} />
              <meshStandardMaterial color="#e9ebea" roughness={0.75} />
            </mesh>
          ))}
          <mesh position={[4.5, base + 0.08, BLUE_WING_CENTER[2]]}>
            <boxGeometry args={[8.7, 0.12, BLUE_WING_LENGTH]} />
            <meshStandardMaterial color="#bbc1c2" roughness={0.9} />
          </mesh>
        </>
      ) : (
        <>
          {!structureOnly && (!hideOuterWall || showWalls) && (
            <>
              <mesh name={`B1_BLUE_F${floor}_OUTER_WALL`} position={[9.88, base + 1.72, BLUE_WING_CENTER[2]]}>
                <boxGeometry args={[0.22, 3.18, BLUE_WING_LENGTH]} />
                <meshStandardMaterial color={WALL} roughness={0.75} />
              </mesh>
              {showWindows && !hideOuterWall && Array.from({ length: BLUE_ROOM_BAYS }, (_, index) => (
                <WindowStrip
                  key={index}
                  name={`B1_BLUE_F${floor}_OUTER_WINDOW_${index + 1}`}
                  position={[10.02, base + 1.75, blueRoomCenter(index)[2]]}
                  rotation={[0, Math.PI / 2, 0]}
                  size={[6.35, 1.5, 0.08]}
                  divisions={4}
                  reducedDetail={reducedDetail}
                />
              ))}
            </>
          )}

          {!structureOnly && (
            <>
              {Array.from({ length: BLUE_ROOM_BAYS }, (_, index) => (
                <BlueRoomFront key={index} floor={floor} index={index} y={base} reducedDetail={reducedDetail} />
              ))}
              {showWalls && Array.from({ length: BLUE_ROOM_BAYS + 1 }, (_, index) => (
                <mesh key={index} name={`B1_BLUE_F${floor}_PARTITION_${index}`} position={[4.9, base + 1.87, 4 + index * ROOM_MODULE]}>
                  <boxGeometry args={[ROOM_DEPTH, 3.26, 0.16]} />
                  <meshStandardMaterial color={WALL} roughness={0.78} />
                </mesh>
              ))}
            </>
          )}

          {!structureOnly && <CorridorBalustrade floor={floor} wing="BLUE" base={base} band={band} />}
        </>
      )}
      {showLights && !structureOnly && !reducedDetail && (
        <group name={`B1_BLUE_F${floor}_CORRIDOR_LIGHTS`}>
          {Array.from({ length: BLUE_ROOM_BAYS * 2 }, (_, index) => (
            <mesh key={index} position={[-1.95, base + 3.18, 6 + index * 4]}>
              <boxGeometry args={[0.22, 0.06, 1.15]} />
              <meshStandardMaterial color="#f8fdff" emissive="#d8f4ff" emissiveIntensity={1.4} roughness={0.35} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}

function TowerStoreyShell({ side, floor, base, opacity }: { side: WingSide; floor: number; base: number; opacity: number }) {
  const center = side === "pink" ? PINK_END_TOWER_CENTER : BLUE_END_TOWER_CENTER;
  const size: [number, number] = side === "pink" ? [8.5, 15] : [15, 8.5];
  const [width, depth] = size;
  const wallInset = 0.14;
  const corner = 1.12;
  const aperture = 6.6;
  const facadeAxis: WallAxis = side === "pink" ? "x" : "z";
  const facadeFixed = side === "pink" ? center[0] - width / 2 + wallInset : center[2] + depth / 2 - wallInset;
  const facadeSpanCenter = side === "pink" ? center[2] : center[0];
  const facadeSpan = side === "pink" ? depth - corner : width - corner;
  const facadeStart = facadeSpanCenter - facadeSpan / 2;
  const facadeEnd = facadeSpanCenter + facadeSpan / 2;
  const glassStart = facadeSpanCenter - aperture / 2;
  const glassEnd = facadeSpanCenter + aperture / 2;
  const glassHeight = 2.28;
  const glassY = base + 1.78;
  const glassMaterial = <meshPhysicalMaterial color="#78a9bd" transparent opacity={Math.min(0.82, opacity)} roughness={0.23} metalness={0.06} depthWrite={false} />;
  const facadePanel = (key: string, along: number, length: number, y: number, height: number, color = "#edf1f0") => (
    <mesh key={key} name={`B1_${side.toUpperCase()}_FACADE_${key}_F${floor}`} position={facadeAxis === "x" ? [facadeFixed, y, along] : [along, y, facadeFixed]} castShadow={opacity > 0.7} receiveShadow>
      <boxGeometry args={facadeAxis === "x" ? [0.28, height, length] : [length, height, 0.28]} />
      <meshStandardMaterial color={color} roughness={0.66} transparent={opacity < 0.99} opacity={opacity} depthWrite={opacity > 0.7} />
    </mesh>
  );

  const portal = STAIR_EXIT_DOOR_CENTERS[side === "pink" ? "left" : "right"];
  const connectionDoor = side === "pink" ? 1.86 : (floor === 1 ? portal[0] : -1.86);
  const sideSpan = side === "pink" ? depth - corner : width - corner;
  const cornerPositions: Array<[number, number, number]> = [
    [center[0] - width / 2 + corner / 2, base + FLOOR_HEIGHT / 2, center[2] - depth / 2 + corner / 2],
    [center[0] - width / 2 + corner / 2, base + FLOOR_HEIGHT / 2, center[2] + depth / 2 - corner / 2],
    [center[0] + width / 2 - corner / 2, base + FLOOR_HEIGHT / 2, center[2] - depth / 2 + corner / 2],
    [center[0] + width / 2 - corner / 2, base + FLOOR_HEIGHT / 2, center[2] + depth / 2 - corner / 2],
  ];

  return (
    <group name={`B1_${side.toUpperCase()}_ROUNDED_ENCLOSED_TOWER_F${floor}`}>
      {cornerPositions.map((position, index) => (
        <mesh key={index} geometry={TOWER_CORNER_GEOMETRY} position={position} castShadow={opacity > 0.7} receiveShadow>
          <meshStandardMaterial color="#edf1f0" roughness={0.68} transparent={opacity < 0.99} opacity={opacity} depthWrite={opacity > 0.7} />
        </mesh>
      ))}

      {facadePanel("SIDE_A", (facadeStart + glassStart) / 2, glassStart - facadeStart, base + FLOOR_HEIGHT / 2, FLOOR_HEIGHT)}
      {facadePanel("SIDE_B", (glassEnd + facadeEnd) / 2, facadeEnd - glassEnd, base + FLOOR_HEIGHT / 2, FLOOR_HEIGHT)}
      {facadePanel("SPANDREL", facadeSpanCenter, aperture, base + 0.34, 0.68, side === "pink" ? "#c970b6" : "#438bb7")}
      {facadePanel("HEADER", facadeSpanCenter, aperture, base + 3.19, 0.62)}
      <mesh name={`B1_${side.toUpperCase()}_STAIR_WINDOW_F${floor}`} position={facadeAxis === "x" ? [facadeFixed + 0.02, glassY, facadeSpanCenter] : [facadeSpanCenter, glassY, facadeFixed - 0.02]}>
        <boxGeometry args={facadeAxis === "x" ? [0.13, glassHeight, aperture] : [aperture, glassHeight, 0.13]} />
        {glassMaterial}
      </mesh>
      {[-1, 0, 1].map((slot) => (
        <mesh key={`mullion-${slot}`} position={facadeAxis === "x" ? [facadeFixed + 0.075, glassY, facadeSpanCenter + slot * 2.18] : [facadeSpanCenter + slot * 2.18, glassY, facadeFixed - 0.075]}>
          <boxGeometry args={facadeAxis === "x" ? [0.12, glassHeight, 0.1] : [0.1, glassHeight, 0.12]} />
          <meshStandardMaterial color="#d6dfe1" metalness={0.35} roughness={0.4} transparent={opacity < 0.99} opacity={opacity} />
        </mesh>
      ))}

      {side === "pink" ? (
        <>
          <StoreyWallFace name={`B1_PINK_TOWER_SOUTH_F${floor}`} axis="z" fixed={center[2] - depth / 2 + wallInset} spanCenter={center[0]} span={width - corner} base={base} opacity={opacity} />
          <StoreyWallFace name={`B1_PINK_TOWER_EAST_F${floor}`} axis="x" fixed={center[0] + width / 2 - wallInset} spanCenter={center[2]} span={sideSpan} base={base} opacity={opacity} doorCenter={connectionDoor} />
          <StoreyWallFace name={`B1_PINK_TOWER_NORTH_F${floor}`} axis="z" fixed={center[2] + depth / 2 - wallInset} spanCenter={center[0]} span={width - corner} base={base} opacity={opacity} doorCenter={floor === 1 ? portal[0] : undefined} />
        </>
      ) : (
        <>
          <StoreyWallFace name={`B1_BLUE_TOWER_WEST_F${floor}`} axis="x" fixed={center[0] - width / 2 + wallInset} spanCenter={center[2]} span={depth - corner} base={base} opacity={opacity} />
          <StoreyWallFace name={`B1_BLUE_TOWER_EAST_F${floor}`} axis="x" fixed={center[0] + width / 2 - wallInset} spanCenter={center[2]} span={depth - corner} base={base} opacity={opacity} />
          <StoreyWallFace name={`B1_BLUE_TOWER_SOUTH_F${floor}`} axis="z" fixed={center[2] - depth / 2 + wallInset} spanCenter={center[0]} span={sideSpan} base={base} opacity={opacity} doorCenter={connectionDoor} />
        </>
      )}

      {floor === 1 && (
        <group name={`B1_${side.toUpperCase()}_GROUND_EXIT_PORTAL`}>
          <mesh name={`B1_${side.toUpperCase()}_EXIT_THRESHOLD_SLAB`} position={[portal[0], base + .17, portal[2]]} receiveShadow>
            <boxGeometry args={[STAIR_EXIT_DOOR_WIDTH, .14, .65]} /><meshStandardMaterial color={FLOOR} roughness={.86} />
          </mesh>
          <mesh position={side === "pink" ? [portal[0], base + STAIR_EXIT_DOOR_HEIGHT + 0.18, center[2] + depth / 2 - 0.3] : [portal[0], base + STAIR_EXIT_DOOR_HEIGHT + 0.18, center[2] - depth / 2 + 0.3]}>
            <boxGeometry args={[1.12, 0.28, 0.08]} />
            <meshStandardMaterial color="#207b59" emissive="#3be39b" emissiveIntensity={0.32} roughness={0.48} />
          </mesh>
        </group>
      )}
    </group>
  );
}

function EndTower({ side }: { side: WingSide }) {
  const mode = useBuilding1Store((state) => state.viewMode);
  const selected = useBuilding1Store((state) => state.selectedFloor);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  const showRoof = useBuilding1Store((state) => state.showRoof);
  const center = side === "pink" ? PINK_END_TOWER_CENTER : BLUE_END_TOWER_CENTER;
  const size: [number, number] = side === "pink" ? [8.5, 15] : [15, 8.5];
  const shellOpacity = mode === "interior" || mode === "single-floor" ? 0.14 : mode === "cutaway" ? 0.52 : 1;

  return (
    <group name={`B1_${side.toUpperCase()}_END_TOWER`}>
      {Array.from({ length: FLOOR_COUNT }, (_, index) => {
        const floor = index + 1;
        if (!visibleFloor(floor, mode, selected)) return null;
        const base = floorBase(floor) + yOffset(floor, explode);
        return (
          <group key={floor}>
            <TowerStoreyShell side={side} floor={floor} base={base} opacity={shellOpacity} />
            {floor === 1 ? (
              <mesh name={`B1_${side.toUpperCase()}_STAIR_SLAB_F1`} position={[center[0], base + SLAB_THICKNESS / 2, center[2]]} receiveShadow>
                <boxGeometry args={[size[0] - 0.22, SLAB_THICKNESS, size[1] - 0.22]} />
                <meshStandardMaterial color={FLOOR} roughness={0.82} />
              </mesh>
            ) : (
              <SlabWithStairOpening
                name={`B1_${side.toUpperCase()}_STAIR_SLAB_F${floor}`}
                center={[center[0], center[2]]}
                size={[size[0] - 0.22, size[1] - 0.22]}
                openingCenter={[center[0], center[2]]}
                y={base + SLAB_THICKNESS / 2}
              />
            )}

          </group>
        );
      })}
      {showRoof && (mode === "exterior" || mode === "structure") && (
        <group name={`B1_${side.toUpperCase()}_TOWER_ROOF_CAP`} position={[center[0], TOTAL_HEIGHT + (explode ? (FLOOR_COUNT - 1) * 1.1 : 0), center[2]]}>
          <mesh position={[0, 0.12, 0]} castShadow receiveShadow><boxGeometry args={[size[0], 0.24, size[1]]} /><meshStandardMaterial color="#e4e8e6" roughness={0.84} /></mesh>
          {[-1, 1].map((sign) => <group key={sign}>
            <mesh position={[sign * (size[0] / 2 - 0.10), 0.50, 0]} castShadow><boxGeometry args={[0.20, 0.56, size[1]]} /><meshStandardMaterial color={ROOF_BLUE} roughness={0.68} /></mesh>
            <mesh position={[0, 0.50, sign * (size[1] / 2 - 0.10)]} castShadow><boxGeometry args={[size[0] - 0.40, 0.56, 0.20]} /><meshStandardMaterial color={ROOF_BLUE} roughness={0.68} /></mesh>
          </group>)}
        </group>
      )}
    </group>
  );
}

function StairWaist({ start, end, color }: { start: [number, number, number]; end: [number, number, number]; color: string }) {
  const transform = useMemo(() => {
    const from = new THREE.Vector3(...start), to = new THREE.Vector3(...end);
    const direction = to.clone().sub(from);
    return { position: from.add(to).multiplyScalar(.5).add(new THREE.Vector3(0, -.25, 0)),
      length: direction.length() + STAIR_TREAD,
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize()) };
  }, [start, end]);
  return <mesh name="B1_INCLINED_STAIR_WAIST" position={transform.position} quaternion={transform.quaternion} castShadow receiveShadow>
    <boxGeometry args={[STAIR_FLIGHT_WIDTH, .20, transform.length]} />
    <meshStandardMaterial color={color} roughness={.84} />
  </mesh>;
}

function SwitchbackStair({
  zone,
  floor,
  base,
  position,
  rotationY = 0,
}: {
  zone: StairZone;
  floor: number;
  base: number;
  position: [number, number, number];
  rotationY?: number;
}) {
  const show = useBuilding1Store((state) => state.showStairs);
  const showLabels = useBuilding1Store((state) => state.showStairLabels);
  const selectedFloor = useBuilding1Store((state) => state.selectedFloor);
  if (!show || floor === FLOOR_COUNT) return null;

  const halfHeight = STAIR_STEPS_PER_FLIGHT * STAIR_RISER;
  const firstX = -STAIR_FLIGHT_CENTER_OFFSET;
  const secondX = STAIR_FLIGHT_CENTER_OFFSET;
  const startZ = STAIR_FIRST_STEP_Z;
  const landingZ = STAIR_MID_LANDING_Z;
  const secondStartZ = STAIR_SECOND_STEP_Z;
  const firstEndZ = startZ - (STAIR_STEPS_PER_FLIGHT - 1) * STAIR_TREAD;
  const secondEndZ = secondStartZ + (STAIR_STEPS_PER_FLIGHT - 1) * STAIR_TREAD;
  const lowerDeckY = base + SLAB_THICKNESS;
  const midDeckY = lowerDeckY + halfHeight;
  const upperDeckY = lowerDeckY + FLOOR_HEIGHT;
  const railHeight = 0.9;
  const landingWidth = CENTRAL_STAIR_ACCESS_LANDING_WIDTH;
  const stairColor = zone === "left" ? "#c7b4c9" : zone === "right" ? "#a9c7d8" : "#b8c0c5";
  const railColor = "#d9e0e3";
  const label = zone === "left" ? "บันไดซ้าย" : zone === "center" ? "บันไดกลาง" : "บันไดขวา";

  const firstRailA: [number, number, number][] = [
    [firstX - STAIR_FLIGHT_WIDTH / 2, lowerDeckY + STAIR_RISER + railHeight, startZ],
    [firstX - STAIR_FLIGHT_WIDTH / 2, midDeckY + railHeight, firstEndZ],
  ];
  const firstRailB: [number, number, number][] = [
    [firstX + STAIR_FLIGHT_WIDTH / 2, lowerDeckY + STAIR_RISER + railHeight, startZ],
    [firstX + STAIR_FLIGHT_WIDTH / 2, midDeckY + railHeight, firstEndZ],
  ];
  const secondRailA: [number, number, number][] = [
    [secondX - STAIR_FLIGHT_WIDTH / 2, midDeckY + STAIR_RISER + railHeight, secondStartZ],
    [secondX - STAIR_FLIGHT_WIDTH / 2, upperDeckY + railHeight, secondEndZ],
  ];
  const secondRailB: [number, number, number][] = [
    [secondX + STAIR_FLIGHT_WIDTH / 2, midDeckY + STAIR_RISER + railHeight, secondStartZ],
    [secondX + STAIR_FLIGHT_WIDTH / 2, upperDeckY + railHeight, secondEndZ],
  ];

  return (
    <group name={`B1_SWITCHBACK_STAIR_${zone.toUpperCase()}_F${floor}`} position={position} rotation={[0, rotationY, 0]}>
      <StairWaist start={[firstX, lowerDeckY + STAIR_RISER, startZ]} end={[firstX, midDeckY, firstEndZ]} color={stairColor} />
      <StairWaist start={[secondX, midDeckY + STAIR_RISER, secondStartZ]} end={[secondX, upperDeckY, secondEndZ]} color={stairColor} />
      {Array.from({ length: STAIR_STEPS_PER_FLIGHT }, (_, index) => {
        const cumulativeRise = (index + 1) * STAIR_RISER;
        const stepZ = startZ - index * STAIR_TREAD;
        return (
        <group key={`first-${index}`} name="B1_SUPPORTED_RISER_FLIGHT_1">
          <mesh
            name={`B1_${zone.toUpperCase()}_F${floor}_FLIGHT1_STEP_${index + 1}`}
            position={[firstX, lowerDeckY + cumulativeRise - STAIR_RISER / 2, stepZ]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[STAIR_FLIGHT_WIDTH, STAIR_RISER, STAIR_TREAD + 0.035]} />
            <meshStandardMaterial color={stairColor} roughness={0.82} />
          </mesh>
          <mesh position={[firstX, lowerDeckY + cumulativeRise + 0.012, stepZ + STAIR_TREAD * 0.39]}>
            <boxGeometry args={[STAIR_FLIGHT_WIDTH * 0.94, 0.025, 0.045]} />
            <meshStandardMaterial color="#e1c04b" roughness={0.68} />
          </mesh>
        </group>
        );
      })}

      <mesh
        name={`B1_${zone.toUpperCase()}_F${floor}_MID_LANDING`}
        position={[0, midDeckY - 0.08, landingZ]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[landingWidth, 0.16, STAIR_LANDING_DEPTH]} />
        <meshStandardMaterial color={stairColor} roughness={0.8} />
      </mesh>

      {Array.from({ length: STAIR_STEPS_PER_FLIGHT }, (_, index) => {
        const cumulativeRise = (index + 1) * STAIR_RISER;
        const stepZ = secondStartZ + index * STAIR_TREAD;
        return (
        <group key={`second-${index}`} name="B1_SUPPORTED_RISER_FLIGHT_2">
          <mesh
            name={`B1_${zone.toUpperCase()}_F${floor}_FLIGHT2_STEP_${index + 1}`}
            position={[secondX, midDeckY + cumulativeRise - STAIR_RISER / 2, stepZ]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[STAIR_FLIGHT_WIDTH, STAIR_RISER, STAIR_TREAD + 0.035]} />
            <meshStandardMaterial color={stairColor} roughness={0.82} />
          </mesh>
          <mesh position={[secondX, midDeckY + cumulativeRise + 0.012, stepZ - STAIR_TREAD * 0.39]}>
            <boxGeometry args={[STAIR_FLIGHT_WIDTH * 0.94, 0.025, 0.045]} />
            <meshStandardMaterial color="#e1c04b" roughness={0.68} />
          </mesh>
        </group>
        );
      })}

      <PhysicalRailSegment start={firstRailA[0]} end={firstRailA[1]} color={railColor} />
      <PhysicalRailSegment start={firstRailB[0]} end={firstRailB[1]} color={railColor} />
      <PhysicalRailSegment start={secondRailA[0]} end={secondRailA[1]} color={railColor} />
      <PhysicalRailSegment start={secondRailB[0]} end={secondRailB[1]} color={railColor} />

      {[0, 2, 4, 6, 7].map((step) => {
        const surfaceY = lowerDeckY + (step + 1) * STAIR_RISER;
        const z = startZ - step * STAIR_TREAD;
        return (
          <group key={`post-a-${step}`}>
            <mesh position={[firstX - STAIR_FLIGHT_WIDTH / 2, surfaceY + railHeight / 2, z]}>
              <cylinderGeometry args={[0.035, 0.035, railHeight, 8]} />
              <meshStandardMaterial color={railColor} metalness={0.45} roughness={0.35} />
            </mesh>
            <mesh position={[firstX + STAIR_FLIGHT_WIDTH / 2, surfaceY + railHeight / 2, z]}>
              <cylinderGeometry args={[0.035, 0.035, railHeight, 8]} />
              <meshStandardMaterial color={railColor} metalness={0.45} roughness={0.35} />
            </mesh>
          </group>
        );
      })}

      {[0, 2, 4, 6, 7].map((step) => {
        const surfaceY = midDeckY + (step + 1) * STAIR_RISER;
        const z = secondStartZ + step * STAIR_TREAD;
        return (
          <group key={`post-b-${step}`}>
            <mesh position={[secondX - STAIR_FLIGHT_WIDTH / 2, surfaceY + railHeight / 2, z]}>
              <cylinderGeometry args={[0.035, 0.035, railHeight, 8]} />
              <meshStandardMaterial color={railColor} metalness={0.45} roughness={0.35} />
            </mesh>
            <mesh position={[secondX + STAIR_FLIGHT_WIDTH / 2, surfaceY + railHeight / 2, z]}>
              <cylinderGeometry args={[0.035, 0.035, railHeight, 8]} />
              <meshStandardMaterial color={railColor} metalness={0.45} roughness={0.35} />
            </mesh>
          </group>
        );
      })}

      <PhysicalRailSegment
        start={[-landingWidth / 2, midDeckY + railHeight, landingZ - STAIR_LANDING_DEPTH / 2]}
        end={[landingWidth / 2, midDeckY + railHeight, landingZ - STAIR_LANDING_DEPTH / 2]}
        color={railColor}
      />
      {[-landingWidth / 2, 0, landingWidth / 2].map((x) => (
        <mesh key={`landing-post-${x}`} position={[x, midDeckY + railHeight / 2, landingZ - STAIR_LANDING_DEPTH / 2]}>
          <cylinderGeometry args={[0.04, 0.04, railHeight, 8]} />
          <meshStandardMaterial color={railColor} metalness={0.45} roughness={0.35} />
        </mesh>
      ))}

      {[-1, 1].map((sign) => <group key={sign}>
        <PhysicalRailSegment start={[sign * landingWidth / 2, midDeckY + railHeight, landingZ - STAIR_LANDING_DEPTH / 2]} end={[sign * landingWidth / 2, midDeckY + railHeight, firstEndZ]} color={railColor} />
        <PhysicalRailSegment start={[sign * landingWidth / 2, midDeckY + railHeight, firstEndZ]} end={[sign * (STAIR_FLIGHT_CENTER_OFFSET + STAIR_FLIGHT_WIDTH / 2), midDeckY + railHeight, firstEndZ]} color={railColor} />
        <PhysicalRailSegment start={[sign * landingWidth / 2, midDeckY, landingZ]} end={[sign * landingWidth / 2, midDeckY + railHeight, landingZ]} color={railColor} />
      </group>)}
      {showLabels && selectedFloor === floor && (
        <Html center position={[0, midDeckY + 1.15, landingZ]} distanceFactor={12}>
          <div className="stair-world-label"><strong>{label}</strong><span>8 ขั้น → กลับตัว 180° → 8 ขั้น</span></div>
        </Html>
      )}
    </group>
  );
}

function StairVoidGuard({ zone, floor, base, position, rotationY = 0 }: {
  zone: StairZone; floor: number; base: number; position: [number, number, number]; rotationY?: number;
}) {
  const show = useBuilding1Store((state) => state.showStairs);
  if (!show || floor === 1) return null;
  const half = STAIR_FLOOR_OPENING_SIZE[0] / 2 + .06;
  const back = -(zone === "center" ? CENTRAL_STAIR_FLOOR_OPENING_SIZE[1] : STAIR_FLOOR_OPENING_SIZE[1]) / 2 - .06;
  const top = base + SLAB_THICKNESS + 1.05;
  const color = "#b5c4cb";
  return <group name={`B1_${zone.toUpperCase()}_F${floor}_STAIR_VOID_GUARD`} position={position} rotation={[0, rotationY, 0]}>
    {[-half, half].map((x) => <group key={x}>
      <PhysicalRailSegment start={[x, top, back]} end={[x, top, STAIR_ACCESS_MIN_Z]} color={color} />
      <PhysicalRailSegment start={[x, top - .5, back]} end={[x, top - .5, STAIR_ACCESS_MIN_Z]} color={color} />
      {[back, -1.4, -.15, STAIR_ACCESS_MIN_Z].map((z) => <PhysicalRailSegment key={z} start={[x, base + SLAB_THICKNESS, z]} end={[x, top, z]} color={color} />)}
    </group>)}
    <PhysicalRailSegment start={[-half, top, back]} end={[half, top, back]} color={color} />
    <PhysicalRailSegment start={[-half, top - .5, back]} end={[half, top - .5, back]} color={color} />
    {[-half, 0, half].map((x) => <PhysicalRailSegment key={x} start={[x, base + SLAB_THICKNESS, back]} end={[x, top, back]} color={color} />)}
  </group>;
}

function StairStorey({ zone, floor }: { zone: StairZone; floor: number }) {
  const show = useBuilding1Store((state) => state.showStairs);
  const mode = useBuilding1Store((state) => state.viewMode);
  const selected = useBuilding1Store((state) => state.selectedFloor);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  if (!show) return null;
  const center = STAIR_ZONE_CENTERS[zone];
  const position: [number, number, number] = [center[0], 0, center[2]];
  const rotationY = zone === "right" ? Math.PI / 2 : 0;
  const base = floorBase(floor) + yOffset(floor, explode);
  const showDeck = visibleFloor(floor, mode, selected);
  const showFlight = mode === "interior" || mode === "single-floor"
    ? floor === Math.max(1, selected - 1)
    : mode === "cutaway" ? floor < selected || selected === 1 && floor === 1 : true;
  const width = CENTRAL_STAIR_ACCESS_LANDING_WIDTH;
  return <>
    {showDeck && <>
      <group position={position} rotation={[0, rotationY, 0]}>
        <mesh name={`B1_${zone.toUpperCase()}_F${floor}_LOWER_ACCESS_LANDING_UPPER_ACCESS_LANDING`}
          position={[0, base + SLAB_THICKNESS - .08, (STAIR_ACCESS_MIN_Z + STAIR_ACCESS_MAX_Z) / 2]} castShadow receiveShadow>
          <boxGeometry args={[width, .16, CENTRAL_STAIR_ACCESS_LANDING_DEPTH]} />
          <meshStandardMaterial color="#bec8cc" roughness={.83} />
        </mesh>
      </group>
      <StairVoidGuard zone={zone} floor={floor} base={base} position={position} rotationY={rotationY} />
    </>}
    {showFlight && <SwitchbackStair zone={zone} floor={floor} base={base} position={position} rotationY={rotationY} />}
  </>;
}

function SchoolStaircases() {
  return <group name="B1_COORDINATED_SCHOOL_STAIRCASES">
    {Array.from({ length: FLOOR_COUNT }, (_, i) => (["left", "center", "right"] as StairZone[]).map((zone) =>
      <StairStorey key={zone + i} zone={zone} floor={i + 1} />))}
  </group>;
}

function CentralCoreFloor({ floor }: { floor: number }) {
  const mode = useBuilding1Store((state) => state.viewMode);
  const selected = useBuilding1Store((state) => state.selectedFloor);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  const showLift = useBuilding1Store((state) => state.showLiftCore);
  const showWalls = useBuilding1Store((state) => state.showInteriorWalls);
  const showWindows = useBuilding1Store((state) => state.showFacadeWindows);
  if (!visibleFloor(floor, mode, selected)) return null;
  const base = floorBase(floor) + yOffset(floor, explode);
  const shellOpacity = mode === "interior" || mode === "single-floor" ? 0.12 : 1;
  const shellDepthWrite = shellOpacity > 0.5;

  return (
    <group name={`B1_CENTRAL_CORE_F${floor}`}>
      {floor === 1 ? (
        <>
          <CurvedCoreCantilever name="B1_CORE_CANTILEVER_F1" slabCenterY={base + SLAB_THICKNESS / 2} />
          <CurvedCoreSlab name="B1_JUNCTION_SLAB_F1" y={base + SLAB_THICKNESS / 2} />
        </>
      ) : (
        <>
          <CurvedCoreCantilever name={`B1_CORE_CANTILEVER_F${floor}`} slabCenterY={base + SLAB_THICKNESS / 2} />
          <CurvedCoreSlab
            name={`B1_JUNCTION_SLAB_F${floor}`}
            openingCenter={[STAIR_ZONE_CENTERS.center[0], STAIR_ZONE_CENTERS.center[2]]}
            y={base + SLAB_THICKNESS / 2}
          />
        </>
      )}
      {floor >= 2 && (
        <CurvedCoreOpenRailing
          name={`B1_CORE_OPEN_CURVE_F${floor}`}
          deckY={base + SLAB_THICKNESS}
        />
      )}
      <group name={`B1_CORE_ENCLOSURE_F${floor}`}>
        <mesh name={`B1_CORE_REAR_WALL_F${floor}`} position={[3.09, base + 1.87, -9.88]} castShadow>
          <boxGeometry args={[13.58, 3.26, 0.24]} />
          <meshStandardMaterial color={WALL} transparent={shellOpacity < 1} opacity={shellOpacity} depthWrite={shellDepthWrite} roughness={0.8} />
        </mesh>
        {/* The east facade meets the blue wing at z=4. The former wall at
            z=6.28 cut directly across classroom 207 on every upper storey. */}
        {[{ y: .68, h: .88 }, { y: 3.04, h: .92 }].map(({ y, h }) => <mesh key={y} name={`B1_CORE_EAST_WALL_BAND_${y}_F${floor}`} position={[9.88, base + y, -2.94]} castShadow>
          <boxGeometry args={[.24, h, 13.88]} />
          <meshStandardMaterial color={WALL} transparent={shellOpacity < 1} opacity={shellOpacity} depthWrite={shellDepthWrite} roughness={.8} />
        </mesh>)}
        {[-9.55, 3.67].map((z) => <mesh key={z} name={`B1_CORE_EAST_WALL_PIER_${z}_F${floor}`} position={[9.88, base + 1.87, z]} castShadow>
          <boxGeometry args={[.24, 3.26, .66]} />
          <meshStandardMaterial color={WALL} transparent={shellOpacity < 1} opacity={shellOpacity} depthWrite={shellDepthWrite} roughness={.8} />
        </mesh>)}
        {showWindows && shellDepthWrite && <WindowStrip name={`B1_CORE_EAST_WINDOW_F${floor}`} position={[9.88, base + 1.85, -2.94]} rotation={[0, Math.PI / 2, 0]} size={[12.56, 1.46, .08]} divisions={7} />}
      </group>
      {showLift && (
        <>
          {CORE_LIFT_X.map((x, index) => (
            <mesh key={x} name={`B1_LIFT_SHAFT_${index + 1}_F${floor}`} position={[x, base + SLAB_THICKNESS + CORE_LIFT_SIZE[1] / 2, CORE_LIFT_Z]}>
              <boxGeometry args={[...CORE_LIFT_SIZE]} />
              <meshStandardMaterial color="#c7cbcc" roughness={0.76} />
            </mesh>
          ))}
          {CORE_LIFT_X.map((x) => <group key={x} name={`B1_LIFT_FRONT_F${floor}`} position={[x, base + SLAB_THICKNESS, CORE_LIFT_Z + CORE_LIFT_SIZE[2] / 2 + .025]}>
            <mesh position={[0, 1.18, .02]}><boxGeometry args={[1.65, 2.36, .07]} /><meshStandardMaterial color="#465862" roughness={.52} /></mesh>
            {[-.38, .38].map((dx) => <mesh key={dx} position={[dx, 1.13, .065]}><boxGeometry args={[.73, 2.20, .045]} /><meshStandardMaterial color="#a6b5bb" metalness={.65} roughness={.34} /></mesh>)}
            <mesh position={[0, .025, .1]}><boxGeometry args={[1.74, .05, .24]} /><meshStandardMaterial color="#66777e" metalness={.55} roughness={.38} /></mesh>
            <mesh position={[.98, 1.14, .055]}><boxGeometry args={[.12, .27, .045]} /><meshStandardMaterial color="#52656f" metalness={.5} roughness={.38} /></mesh>
            <mesh position={[0, 2.63, .03]}><boxGeometry args={[.48, .19, .06]} /><meshStandardMaterial color="#274450" roughness={.6} /></mesh>
          </group>)}
        </>
      )}

      {showWalls && (
        <>
          <mesh position={[4.9, base + 1.1, 3.4]}>
            <boxGeometry args={[0.48, 0.72, 0.18]} />
            <meshStandardMaterial color="#d62f2f" roughness={0.48} />
          </mesh>
        </>
      )}
    </group>
  );
}

function RoofDetails() {
  const show = useBuilding1Store((state) => state.showRoof);
  const mode = useBuilding1Store((state) => state.viewMode);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  if (!show || mode === "single-floor" || mode === "interior" || mode === "cutaway") return null;
  const y = TOTAL_HEIGHT + (explode ? (FLOOR_COUNT - 1) * 1.1 : 0);
  // Close the square rear junction where the pink and blue wing roof plates meet.  The closure
  // is roof-only: its underside stays above floor 9, so the lift, central stair and evacuation
  // connector below remain untouched.  A 15 mm top reveal prevents coplanar flashing against
  // the existing curved-core roof while reading as one continuous waterproof slab.
  const rearJunctionMinX = -3.65;
  const rearJunctionMaxX = 9.88;
  const rearJunctionMinZ = -9.88;
  const rearJunctionMaxZ = 3.65;
  const rearJunctionWidth = rearJunctionMaxX - rearJunctionMinX;
  const rearJunctionDepth = rearJunctionMaxZ - rearJunctionMinZ;
  return (
    <group name="B1_ROOF_DETAILS">
      <mesh position={[PINK_WING_CENTER[0], y + 0.14, PINK_WING_CENTER[2]]}>
        <boxGeometry args={[PINK_WING_LENGTH + 0.7, 0.28, WING_DEPTH + 0.4]} />
        <meshStandardMaterial color="#eff1ef" roughness={0.78} />
      </mesh>
      <mesh position={[PINK_WING_CENTER[0], y + 0.50, 3.65]}>
        <boxGeometry args={[PINK_WING_LENGTH + 0.8, 0.56, 0.20]} />
        <meshStandardMaterial color={ROOF_BLUE} roughness={0.55} />
      </mesh>
      <mesh position={[BLUE_WING_CENTER[0], y + 0.14, BLUE_WING_CENTER[2]]}>
        <boxGeometry args={[WING_DEPTH + 0.4, 0.28, BLUE_WING_LENGTH + 0.7]} />
        <meshStandardMaterial color="#eff1ef" roughness={0.78} />
      </mesh>
      <mesh position={[-3.65, y + 0.50, BLUE_WING_CENTER[2]]}>
        <boxGeometry args={[0.20, 0.56, BLUE_WING_LENGTH + 0.8]} />
        <meshStandardMaterial color={ROOF_BLUE} roughness={0.55} />
      </mesh>
      <mesh
        name="B1_REAR_JUNCTION_RECTANGULAR_ROOF_CLOSURE"
        position={[
          (rearJunctionMinX + rearJunctionMaxX) / 2,
          y + 0.145,
          (rearJunctionMinZ + rearJunctionMaxZ) / 2,
        ]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[rearJunctionWidth, 0.3, rearJunctionDepth]} />
        <meshStandardMaterial color="#eff1ef" roughness={0.78} metalness={0.01} />
      </mesh>
      <CurvedCoreCantilever name="B1_CORE_CANTILEVER_ROOF" slabCenterY={y + 0.14} />
      <CurvedCoreSlab name="B1_CURVED_CORE_ROOF" y={y + 0.14} thickness={0.28} />
      <CurvedCoreOpenRailing name="B1_CORE_OPEN_CURVE_ROOF" deckY={y + 0.28} color="#dcecf2" />
    </group>
  );
}

function ArchitecturalEnhancements() {
  const showRoof = useBuilding1Store((state) => state.showRoof);
  const mode = useBuilding1Store((state) => state.viewMode);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  if (mode !== "exterior") return null;
  const roofY = TOTAL_HEIGHT + (explode ? (FLOOR_COUNT - 1) * 1.1 : 0);
  return (
    <group name="B1_ARCHITECTURAL_MODEL_REFINEMENT">
      {showRoof && (
        <group name="B1_ROOF_SERVICE_DETAILS">
          {[[-10, -7], [-20, -7], [-40, -7], [7, 12], [7, 28], [7, 44]].map(([x, z], index) => (
            <group key={index} position={[x, roofY + 0.66, z]}>
              <mesh><cylinderGeometry args={[0.42, 0.52, 0.72, 18]} /><meshStandardMaterial color="#a6b0b3" metalness={0.48} roughness={0.42} /></mesh>
              <mesh position={[0, 0.42, 0]}><cylinderGeometry args={[0.58, 0.48, 0.12, 18]} /><meshStandardMaterial color="#52656d" metalness={0.55} roughness={0.32} /></mesh>
            </group>
          ))}
          {[[-50, -8], [-6, -8], [8, 50]].map(([x, z], index) => (
            <group key={`rod-${index}`} position={[x, roofY + 0.25, z]}>
              <mesh position={[0, 2.15, 0]}><cylinderGeometry args={[0.025, 0.045, 4.3, 10]} /><meshStandardMaterial color="#77858b" metalness={0.82} roughness={0.22} /></mesh>
              <mesh position={[0, 4.35, 0]}><sphereGeometry args={[0.09, 10, 8]} /><meshStandardMaterial color="#d8e1e4" metalness={0.9} roughness={0.18} /></mesh>
            </group>
          ))}
        </group>
      )}
    </group>
  );
}

/**
 * Seals the complete rear perimeter of the L-shaped school.
 *
 * The long wing walls stop where their classroom modules end, leaving the
 * square junction behind the central core visually open from the rear.  The
 * two return walls below bridge those endpoints on every visible storey. They
 * stay outside the central slab/navigation envelope, so the lift, stair,
 * courtyard balcony and evacuation paths remain unchanged.
 */
function RearBuildingEnvelope() {
  const mode = useBuilding1Store((state) => state.viewMode);
  const selected = useBuilding1Store((state) => state.selectedFloor);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  if (mode === "interior" || mode === "single-floor" || mode === "structure") return null;
  const wallHeight = FLOOR_HEIGHT - 0.16;
  const wallY = wallHeight / 2 + 0.08;
  const rearZ = -9.88;
  const rearX = 9.88;
  const pinkInnerEndX = PINK_WING_CENTER[0] + PINK_WING_LENGTH / 2;
  const blueInnerStartZ = BLUE_WING_CENTER[2] - BLUE_WING_LENGTH / 2;
  const seamOverlap = 0.22;
  const junctionRearLength = rearX - pinkInnerEndX + seamOverlap;
  const junctionRearCenterX = (rearX + pinkInnerEndX) / 2;
  const junctionReturnLength = blueInnerStartZ - rearZ + seamOverlap;
  const junctionReturnCenterZ = (blueInnerStartZ + rearZ) / 2;
  const rearWallMaterial = () => (
    <meshStandardMaterial color="#e8ecea" roughness={0.72} metalness={0.015} />
  );
  return (
    <group name="B1_SEALED_REAR_ENVELOPE">
      <mesh name="B1_PINK_GROUND_REAR_WALL" position={[PINK_WING_CENTER[0], wallY, -9.88]} castShadow receiveShadow>
        <boxGeometry args={[PINK_WING_LENGTH + 0.16, wallHeight, 0.28]} />
        <meshStandardMaterial color="#e8ecea" roughness={0.72} />
      </mesh>
      <mesh name="B1_BLUE_GROUND_REAR_WALL" position={[9.88, wallY, BLUE_WING_CENTER[2]]} castShadow receiveShadow>
        <boxGeometry args={[0.28, wallHeight, BLUE_WING_LENGTH + 0.16]} />
        <meshStandardMaterial color="#e8ecea" roughness={0.72} />
      </mesh>
      <group name="B1_REAR_JUNCTION_FULL_HEIGHT_CLOSURE">
        {Array.from({ length: FLOOR_COUNT }, (_, index) => {
          const floor = index + 1;
          if (!visibleFloor(floor, mode, selected)) return null;
          const base = floorBase(floor) + yOffset(floor, explode);
          const storeyY = base + FLOOR_HEIGHT / 2;
          return (
            <group key={floor} name={`B1_REAR_JUNCTION_CLOSURE_F${floor}`}>
              <mesh
                name={`B1_REAR_JUNCTION_SOUTH_WALL_F${floor}`}
                position={[junctionRearCenterX, storeyY, rearZ]}
                castShadow
                receiveShadow
              >
                <boxGeometry args={[junctionRearLength, FLOOR_HEIGHT, 0.28]} />
                {rearWallMaterial()}
              </mesh>
              <mesh
                name={`B1_REAR_JUNCTION_EAST_RETURN_F${floor}`}
                position={[rearX, storeyY, junctionReturnCenterZ]}
                castShadow
                receiveShadow
              >
                <boxGeometry args={[0.28, FLOOR_HEIGHT, junctionReturnLength]} />
                {rearWallMaterial()}
              </mesh>
              <RoundedBox
                name={`B1_REAR_JUNCTION_WEATHER_SEAL_F${floor}`}
                args={[0.56, FLOOR_HEIGHT, 0.56]}
                radius={0.14}
                smoothness={3}
                position={[rearX, storeyY, rearZ]}
                castShadow
                receiveShadow
              >
                <meshStandardMaterial color="#e4e9e7" roughness={0.68} metalness={0.02} />
              </RoundedBox>
            </group>
          );
        })}
      </group>
      <mesh name="B1_PINK_REAR_FOUNDATION_SEAL" position={[PINK_WING_CENTER[0], 0.28, -10.055]} receiveShadow>
        <boxGeometry args={[PINK_WING_LENGTH + 0.42, 0.56, 0.18]} />
        <meshStandardMaterial color="#778288" roughness={0.84} />
      </mesh>
      <mesh name="B1_BLUE_REAR_FOUNDATION_SEAL" position={[10.055, 0.28, BLUE_WING_CENTER[2]]} receiveShadow>
        <boxGeometry args={[0.18, 0.56, BLUE_WING_LENGTH + 0.42]} />
        <meshStandardMaterial color="#778288" roughness={0.84} />
      </mesh>
      <mesh name="B1_REAR_JUNCTION_SOUTH_FOUNDATION_SEAL" position={[junctionRearCenterX, 0.28, -10.055]} receiveShadow>
        <boxGeometry args={[junctionRearLength + 0.24, 0.56, 0.18]} />
        <meshStandardMaterial color="#778288" roughness={0.84} />
      </mesh>
      <mesh name="B1_REAR_JUNCTION_EAST_FOUNDATION_SEAL" position={[10.055, 0.28, junctionReturnCenterZ]} receiveShadow>
        <boxGeometry args={[0.18, 0.56, junctionReturnLength + 0.24]} />
        <meshStandardMaterial color="#778288" roughness={0.84} />
      </mesh>
      <RoundedBox name="B1_REAR_CORNER_WEATHER_SEAL" args={[0.54, FLOOR_HEIGHT, 0.54]} radius={0.14} smoothness={3} position={[9.82, FLOOR_HEIGHT / 2, -9.82]} castShadow>
        <meshStandardMaterial color="#e4e9e7" roughness={0.68} />
      </RoundedBox>
    </group>
  );
}

function RoomFixtures({ room, base }: { room: RoomModuleDefinition; base: number }) {
  const showFurniture = useBuilding1Store((state) => state.showFurniture);
  const showWalls = useBuilding1Store((state) => state.showInteriorWalls);
  if (!showFurniture || !showWalls) return null;
  return (
    <group name={`${room.id}_FIXTURES`} position={room.side === "pink" ? [room.position[0], base + SLAB_THICKNESS, -9.62] : [9.62, base + SLAB_THICKNESS, room.position[2]]} rotation={[0, room.side === "pink" ? 0 : -Math.PI / 2, 0]}>
      <mesh position={[0, 1.45, 0]}><boxGeometry args={[5.0, 1.25, 0.08]} /><meshStandardMaterial color="#b5bfc0" roughness={0.48} metalness={0.22} /></mesh>
      <mesh position={[0, 1.45, 0.05]}>
        <boxGeometry args={[4.8, 1.08, 0.025]} />
        <meshStandardMaterial color="#304c42" roughness={0.94} />
      </mesh>
      <mesh position={[0, 0.88, 0.10]}><boxGeometry args={[4.9, 0.035, 0.14]} /><meshStandardMaterial color="#89999d" roughness={0.48} metalness={0.22} /></mesh>
      <mesh geometry={TEACHER_DESK_GEOMETRY} position={[0, 0, 1.0]} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.72} />
      </mesh>
    </group>
  );
}

function WalkCeilings() {
  const walking = useWalkStore((state) => state.enabled);
  const floor = useWalkStore((state) => state.floor);
  if (!walking || floor === 1) return null;
  const y = floorBase(floor) + 3.25;
  return <group name="B1_WALK_VIEW_CEILINGS">
    <mesh position={[PINK_WING_CENTER[0], y, PINK_WING_CENTER[2] + 0.1]} castShadow><boxGeometry args={[PINK_WING_LENGTH, 0.08, WING_DEPTH + 0.2]} /><meshStandardMaterial color="#e7eae6" roughness={0.96} /></mesh>
    <mesh position={[BLUE_WING_CENTER[0] - 0.1, y, BLUE_WING_CENTER[2]]} castShadow><boxGeometry args={[WING_DEPTH + 0.2, 0.08, BLUE_WING_LENGTH]} /><meshStandardMaterial color="#e7eae6" roughness={0.96} /></mesh>
  </group>;
}

function FurnitureInstances() {
  const mode = useBuilding1Store((state) => state.viewMode);
  const selectedFloor = useBuilding1Store((state) => state.selectedFloor);
  const showFurniture = useBuilding1Store((state) => state.showFurniture);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  const deskRef = useRef<THREE.InstancedMesh | null>(null);
  const chairRef = useRef<THREE.InstancedMesh | null>(null);
  const deskGeometry = useMemo(() => createSchoolDesk(), []);
  const chairGeometry = useMemo(() => createSchoolChair(), []);
  useEffect(() => () => { deskGeometry.dispose(); chairGeometry.dispose(); }, [deskGeometry, chairGeometry]);

  const active = showFurniture && (mode === "interior" || mode === "single-floor" || mode === "cutaway");
  const transforms = useMemo(() => {
    if (!active || selectedFloor === 1) return { desks: [] as THREE.Matrix4[], chairs: [] as THREE.Matrix4[] };
    const desks: THREE.Matrix4[] = [];
    const chairs: THREE.Matrix4[] = [];
    const rooms = ROOM_MODULES.filter((room) => room.floor === selectedFloor);
    const extraY = yOffset(selectedFloor, explode);

    rooms.forEach((room) => {
      const base = floorBase(room.floor) + extraY;
      const rows = 5;
      const doubleDesksPerRow = 4;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < doubleDesksPerRow; col += 1) {
          if (room.side === "pink") {
            const x = room.position[0] - 2.55 + col * 1.7;
            const z = -7.8 + row * 1.34;
            desks.push(new THREE.Matrix4().compose(
              new THREE.Vector3(x, base + SLAB_THICKNESS, z),
              new THREE.Quaternion(),
              new THREE.Vector3(1, 1, 1),
            ));
            for (const seatOffset of [-0.38, 0.38]) {
              chairs.push(new THREE.Matrix4().compose(
                new THREE.Vector3(x + seatOffset, base + SLAB_THICKNESS, z + 0.5),
                new THREE.Quaternion(),
                new THREE.Vector3(1, 1, 1),
              ));
            }
          } else {
            const x = 7.8 - row * 1.34;
            const z = room.position[2] - 2.55 + col * 1.7;
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0));
            desks.push(new THREE.Matrix4().compose(
              new THREE.Vector3(x, base + SLAB_THICKNESS, z),
              q,
              new THREE.Vector3(1, 1, 1),
            ));
            for (const seatOffset of [-0.38, 0.38]) {
              chairs.push(new THREE.Matrix4().compose(
                new THREE.Vector3(x - 0.5, base + SLAB_THICKNESS, z + seatOffset),
                q,
                new THREE.Vector3(1, 1, 1),
              ));
            }
          }
        }
      }
    });
    return { desks, chairs };
  }, [active, explode, selectedFloor]);

  useLayoutEffect(() => {
    if (!deskRef.current || !chairRef.current) return;
    transforms.desks.forEach((matrix, index) => deskRef.current?.setMatrixAt(index, matrix));
    transforms.chairs.forEach((matrix, index) => chairRef.current?.setMatrixAt(index, matrix));
    deskRef.current.count = transforms.desks.length;
    chairRef.current.count = transforms.chairs.length;
    deskRef.current.instanceMatrix.needsUpdate = true;
    chairRef.current.instanceMatrix.needsUpdate = true;
    deskRef.current.computeBoundingSphere();
    chairRef.current.computeBoundingSphere();
  }, [transforms]);

  if (!active) return null;
  return (
    <group name="B1_SELECTED_FLOOR_FURNITURE">
      <instancedMesh ref={deskRef} args={[deskGeometry, undefined, 240]} count={transforms.desks.length} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.72} />
      </instancedMesh>
      <instancedMesh ref={chairRef} args={[chairGeometry, undefined, 480]} count={transforms.chairs.length} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.76} />
      </instancedMesh>
      {ROOM_MODULES.filter((room) => room.floor === selectedFloor).map((room) => (
        <RoomFixtures key={room.id} room={room} base={floorBase(room.floor) + yOffset(room.floor, explode)} />
      ))}
    </group>
  );
}

function ClassroomVolumes() {
  const mode = useBuilding1Store((state) => state.viewMode);
  const selected = useBuilding1Store((state) => state.selectedFloor);
  const showVolumes = useBuilding1Store((state) => state.showRoomVolumes);
  const showLabels = useBuilding1Store((state) => state.showRoomLabels);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  return (
    <group name="B1_ROOM_SEMANTICS">
      {ROOM_MODULES.map((room) => {
        if (!visibleFloor(room.floor, mode, selected)) return null;
        const extra = yOffset(room.floor, explode);
        const selectedRoomFloor = room.floor === selected;
        return (
          <group key={room.id} position={[room.position[0], room.position[1] + extra, room.position[2]]}>
            <mesh name={room.id} userData={{ semanticType: room.roomType, roomName: room.name, floor: room.floor, peopleCount: room.peopleCount }}>
              <boxGeometry args={room.size} />
              <meshStandardMaterial
                color={room.side === "pink" ? "#ff60d8" : "#557cff"}
                transparent
                opacity={showVolumes ? (selectedRoomFloor ? 0.22 : 0.06) : 0.002}
                depthWrite={showVolumes}
              />
            </mesh>
            {showLabels && selectedRoomFloor && (mode === "interior" || mode === "single-floor" || mode === "cutaway") && (
              <SectionLabel text={room.name} position={[0, room.size[1] / 2 + 0.48, 0]} />
            )}
          </group>
        );
      })}
    </group>
  );
}

function EvacuationRoute() {
  const show = useBuilding1Store((state) => state.showEvacuationRoute);
  if (!show) return null;
  const points: [number, number, number][] = [[-10, 0.65, 15], [-12, 0.65, 32], [-8, 0.65, 54], [FIELD_CENTER[0], 0.65, FIELD_CENTER[2] - 20]];
  return <Line points={points} color="#27d2ff" lineWidth={4} dashed dashScale={2.2} dashSize={1.3} gapSize={0.6} />;
}

function PopulationPreview() {
  const show = useBuilding1Store((state) => state.showPopulation);
  const workMode = useEvacuationStore((state) => state.workMode);
  const status = useEvacuationStore((state) => state.status);
  const enabled = show && workMode === "editor" && status === "idle";
  const mode = useBuilding1Store((state) => state.populationMode);
  const profile = useBuilding1Store((state) => state.populationProfile);
  const selectedFloor = useBuilding1Store((state) => state.selectedFloor);
  const viewMode = useBuilding1Store((state) => state.viewMode);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  const maleStudentRef = useRef<THREE.InstancedMesh | null>(null);
  const femaleStudentRef = useRef<THREE.InstancedMesh | null>(null);
  const compactStudents = viewMode === "exterior" || viewMode === "cutaway" || mode === "assembly";
  const maleStudentGeometry = useMemo(() => createStudentGeometry("male", compactStudents), [compactStudents]);
  const femaleStudentGeometry = useMemo(() => createStudentGeometry("female", compactStudents), [compactStudents]);

  const positions = useMemo(() => {
    const values: THREE.Vector3[] = [];
    const requestedCount = profile === "full"
      ? FULL_BUILDING_CAPACITY
      : profile === "selected-floor"
        ? (selectedFloor === 1 ? 0 : ROOMS_PER_UPPER_FLOOR * CLASSROOM_CAPACITY)
        : TARGET_POPULATION;

    if (mode === "assembly") {
      const cols = 64;
      const spacing = 0.64;
      const rows = Math.ceil(requestedCount / cols);
      for (let index = 0; index < requestedCount; index += 1) {
        const row = Math.floor(index / cols);
        const col = index % cols;
        values.push(new THREE.Vector3(
          FIELD_CENTER[0] - ((cols - 1) * spacing) / 2 + col * spacing,
          0.58,
          FIELD_CENTER[2] - ((rows - 1) * spacing) / 2 + row * spacing,
        ));
      }
      return values;
    }

    const profileRooms = profile === "selected-floor"
      ? CLASSROOMS.filter((room) => room.floor === selectedFloor)
      : CLASSROOMS;
    const rooms = profileRooms.filter((room) => visibleFloor(room.floor, viewMode, selectedFloor));
    let remaining = requestedCount;
    for (const room of rooms) {
      const roomCount = profile === "full" || profile === "selected-floor"
        ? CLASSROOM_CAPACITY
        : Math.min(room.peopleCount, remaining);
      remaining -= roomCount;
      const cols = 8;
      for (let index = 0; index < roomCount; index += 1) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const position = studentStartPosition(room, row * cols + col);
        values.push(new THREE.Vector3(position[0], position[1] + yOffset(room.floor, explode), position[2]));
      }
      if (remaining <= 0) break;
    }
    return values;
  }, [explode, mode, profile, selectedFloor, viewMode]);

  useLayoutEffect(() => {
    if (!maleStudentRef.current || !femaleStudentRef.current) return;
    const matrix = new THREE.Matrix4();
    let maleCount = 0;
    let femaleCount = 0;
    positions.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      if (index % 2 === 0) femaleStudentRef.current?.setMatrixAt(femaleCount++, matrix);
      else maleStudentRef.current?.setMatrixAt(maleCount++, matrix);
    });
    maleStudentRef.current.count = maleCount;
    femaleStudentRef.current.count = femaleCount;
    maleStudentRef.current.instanceMatrix.needsUpdate = true;
    femaleStudentRef.current.instanceMatrix.needsUpdate = true;
  }, [enabled, positions]);

  useEffect(() => () => {
    maleStudentGeometry.dispose();
    femaleStudentGeometry.dispose();
  }, [femaleStudentGeometry, maleStudentGeometry]);

  if (!enabled) return null;
  return (
    <group name="B1_STUDENT_POPULATION_PREVIEW">
      <instancedMesh ref={maleStudentRef} name="B1_PREVIEW_STUDENTS_MALE" args={[maleStudentGeometry, undefined, 2200]} frustumCulled={false}>
        <meshStandardMaterial vertexColors roughness={0.68} metalness={0.01} />
      </instancedMesh>
      <instancedMesh ref={femaleStudentRef} name="B1_PREVIEW_STUDENTS_FEMALE" args={[femaleStudentGeometry, undefined, 2200]} frustumCulled={false}>
        <meshStandardMaterial vertexColors roughness={0.68} metalness={0.01} />
      </instancedMesh>
    </group>
  );
}

export function Building1DigitalTwin() {
  const setModelReport = useMapperStore((state) => state.setModelReport);
  const setModelLoading = useMapperStore((state) => state.setModelLoading);
  const setModelError = useMapperStore((state) => state.setModelError);
  const addToast = useMapperStore((state) => state.addToast);
  const mode = useBuilding1Store((state) => state.viewMode);
  const selected = useBuilding1Store((state) => state.selectedFloor);
  const explode = useBuilding1Store((state) => state.explodeFloors);
  const showLabels = useBuilding1Store((state) => state.showRoomLabels);
  const workMode = useEvacuationStore((state) => state.workMode);
  const modelRootRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    setModelReport({
      modelName: "อาคารเรียน 1 และสนามฟุตบอล — แบบจำลองดิจิทัลเพื่อการอพยพ",
      fileSize: 0,
      sha256: "generated-from-building1-plans-field-official-physics",
      objectCount: 3508,
      meshCount: 3002,
      materialCount: 51,
      triangleCount: 433000,
      boundsMin: [-72, 0, -24],
      boundsMax: [62, TOTAL_HEIGHT + 14, 138],
      boundsSize: [134, TOTAL_HEIGHT + 14, 162],
      boundsCenter: [-5, (TOTAL_HEIGHT + 14) / 2, 57],
      items: [],
    });
    setModelError(null);
    setModelLoading(false);
    addToast("success", "เปิดแบบจำลองอาคารเรียน 1 สนามฟุตบอล ลู่วิ่ง และจุดรวมพลสำหรับ 3,000 คนแล้ว");
  }, [addToast, setModelError, setModelLoading, setModelReport]);

  return (
    <group ref={modelRootRef} name="BUILDING_1_EVACUATION_MODEL">
      <ArchitecturalAudit rootRef={modelRootRef} />
      <StaticBoxBatcher rootRef={modelRootRef} enabled={workMode === "simulation"} />
      <CampusLandscape />
      <mesh name="BUILDING1_COURTYARD" position={[-24, 0.04, 27]} receiveShadow>
        <boxGeometry args={[43, 0.08, 41]} />
        <meshStandardMaterial color="#c4c7c5" roughness={0.91} />
      </mesh>
      <mesh name="MONUMENT_BASE" position={[-17, 0.28, 18]}>
        <cylinderGeometry args={[3.2, 3.55, 0.56, 48]} />
        <meshStandardMaterial color="#555d61" roughness={0.76} />
      </mesh>

      {Array.from({ length: FLOOR_COUNT }, (_, index) => (
        <group key={index}>
          <PinkWingFloor floor={index + 1} />
          <BlueWingFloor floor={index + 1} />
          <CentralCoreFloor floor={index + 1} />
        </group>
      ))}
      <EndTower side="pink" />
      <EndTower side="blue" />
      <SchoolStaircases />
      <RearBuildingEnvelope />
      <RoofDetails />
      <ArchitecturalEnhancements />
      <CampusIdentity />
      <WalkCeilings />
      <FurnitureInstances />
      {workMode === "editor" && <ClassroomVolumes />}
      <SportsFieldModel />
      <EvacuationRoute />
      <PopulationPreview />

      {showLabels && (
        <>
          <SectionLabel text="ปีกสีชมพู" position={[-25, TOTAL_HEIGHT + 2.2, -3]} />
          <SectionLabel text="ปีกสีฟ้า" position={[3, TOTAL_HEIGHT + 2.2, 30]} />
          <SectionLabel text="แกนกลาง · ลิฟต์ · บันได" position={[0, TOTAL_HEIGHT + 3.2, 0]} />
        </>
      )}
      {workMode === "editor" && (
        <Html center position={[-14, TOTAL_HEIGHT + (explode ? (FLOOR_COUNT - 1) * 1.1 : 0) + 4.2, 8]}>
          <div className="building-world-title"><strong>อาคารเรียน 1 และสนามฟุตบอล</strong><span>{mode === "exterior" ? "โมเดลภายนอกละเอียด" : mode === "structure" ? "โครงสร้าง" : `ชั้น ${selected} · ภายใน`}</span></div>
        </Html>
      )}
    </group>
  );
}
