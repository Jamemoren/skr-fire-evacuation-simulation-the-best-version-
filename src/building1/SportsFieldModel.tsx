import { Html, Line } from "@react-three/drei";
import { useMemo, type ReactNode } from "react";
import * as THREE from "three";
import { FIELD_CENTER } from "./building1Data";
import { useBuilding1Store } from "./building1Store";

const FIELD_GREEN = "#4f9f61";
const TRACK = "#d9a34f";
const TRACK_LINE = "#fff4d5";
const MARKING = "#f7fbf7";
const CURB = "#ece9df";
const METAL = "#d9e0e3";
const NET = "#cfd7d9";

const OUTER_STRAIGHT_HALF = 22;
const OUTER_RADIUS = 25;
const INNER_STRAIGHT_HALF = 22;
const INNER_RADIUS = 17;
const TRACK_WIDTH = OUTER_RADIUS - INNER_RADIUS;
const TRACK_LENGTH = OUTER_STRAIGHT_HALF * 2 + OUTER_RADIUS * 2;
const TRACK_DEPTH = OUTER_RADIUS * 2;

const PITCH_LENGTH = 62;
const PITCH_WIDTH = 30;
const GOAL_WIDTH = 7.2;
const GOAL_HEIGHT = 2.45;
const GOAL_DEPTH = 2.0;

const ASSEMBLY_ZONES = [
  { id: "A", offset: [-20, -8] as const, capacity: 500 },
  { id: "B", offset: [0, -8] as const, capacity: 500 },
  { id: "C", offset: [20, -8] as const, capacity: 500 },
  { id: "D", offset: [-20, 8] as const, capacity: 500 },
  { id: "E", offset: [0, 8] as const, capacity: 500 },
  { id: "F", offset: [20, 8] as const, capacity: 500 },
];

function stadiumLoopPoints(straightHalf: number, radius: number, y = 0.24, segments = 44): [number, number, number][] {
  const points: [number, number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = -Math.PI / 2 + (Math.PI * i) / segments;
    points.push([straightHalf + Math.cos(a) * radius, y, Math.sin(a) * radius]);
  }
  for (let i = 0; i <= segments; i += 1) {
    const a = Math.PI / 2 + (Math.PI * i) / segments;
    points.push([-straightHalf + Math.cos(a) * radius, y, Math.sin(a) * radius]);
  }
  points.push(points[0]);
  return points;
}

function makeTrackGeometry(): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-OUTER_STRAIGHT_HALF, -OUTER_RADIUS);
  shape.lineTo(OUTER_STRAIGHT_HALF, -OUTER_RADIUS);
  shape.absarc(OUTER_STRAIGHT_HALF, 0, OUTER_RADIUS, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(-OUTER_STRAIGHT_HALF, OUTER_RADIUS);
  shape.absarc(-OUTER_STRAIGHT_HALF, 0, OUTER_RADIUS, Math.PI / 2, Math.PI * 1.5, false);

  const hole = new THREE.Path();
  hole.moveTo(-INNER_STRAIGHT_HALF, -INNER_RADIUS);
  hole.lineTo(INNER_STRAIGHT_HALF, -INNER_RADIUS);
  hole.absarc(INNER_STRAIGHT_HALF, 0, INNER_RADIUS, -Math.PI / 2, Math.PI / 2, false);
  hole.lineTo(-INNER_STRAIGHT_HALF, INNER_RADIUS);
  hole.absarc(-INNER_STRAIGHT_HALF, 0, INNER_RADIUS, Math.PI / 2, Math.PI * 1.5, false);
  shape.holes.push(hole);
  return new THREE.ShapeGeometry(shape, 64);
}

function RectLine({ width, depth, y = 0.31, x = 0, z = 0 }: { width: number; depth: number; y?: number; x?: number; z?: number }) {
  const x0 = x - width / 2;
  const x1 = x + width / 2;
  const z0 = z - depth / 2;
  const z1 = z + depth / 2;
  return <Line points={[[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [x0, y, z0]]} color={MARKING} lineWidth={1.7} />;
}

function CircleLine({ radius, y = 0.31, x = 0, z = 0 }: { radius: number; y?: number; x?: number; z?: number }) {
  const points = Array.from({ length: 65 }, (_, index) => {
    const a = (index / 64) * Math.PI * 2;
    return [x + Math.cos(a) * radius, y, z + Math.sin(a) * radius] as [number, number, number];
  });
  return <Line points={points} color={MARKING} lineWidth={1.7} />;
}

function Goal({ side }: { side: -1 | 1 }) {
  const x = side * (PITCH_LENGTH / 2 + 0.52);
  const postY = GOAL_HEIGHT / 2 + 0.34;
  const backX = x + side * GOAL_DEPTH;
  const netLines: ReactNode[] = [];
  for (let i = 0; i <= 6; i += 1) {
    const z = -GOAL_WIDTH / 2 + (GOAL_WIDTH * i) / 6;
    netLines.push(
      <Line key={`v-${i}`} points={[[x, 0.36, z], [backX, 0.36, z], [backX, GOAL_HEIGHT + 0.34, z], [x, GOAL_HEIGHT + 0.34, z]]} color={NET} lineWidth={0.6} />,
    );
  }
  for (let i = 0; i <= 4; i += 1) {
    const y = 0.36 + (GOAL_HEIGHT * i) / 4;
    netLines.push(
      <Line key={`h-${i}`} points={[[x, y, -GOAL_WIDTH / 2], [backX, y, -GOAL_WIDTH / 2], [backX, y, GOAL_WIDTH / 2], [x, y, GOAL_WIDTH / 2]]} color={NET} lineWidth={0.6} />,
    );
  }

  return (
    <group name={side < 0 ? "FOOTBALL_GOAL_WEST" : "FOOTBALL_GOAL_EAST"}>
      <mesh position={[x, postY, -GOAL_WIDTH / 2]} castShadow><cylinderGeometry args={[0.06, 0.06, GOAL_HEIGHT, 10]} /><meshStandardMaterial color={METAL} metalness={0.55} roughness={0.28} /></mesh>
      <mesh position={[x, postY, GOAL_WIDTH / 2]} castShadow><cylinderGeometry args={[0.06, 0.06, GOAL_HEIGHT, 10]} /><meshStandardMaterial color={METAL} metalness={0.55} roughness={0.28} /></mesh>
      <mesh position={[x, GOAL_HEIGHT + 0.34, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[0.06, 0.06, GOAL_WIDTH, 10]} /><meshStandardMaterial color={METAL} metalness={0.55} roughness={0.28} /></mesh>
      {netLines}
    </group>
  );
}

function FootballPitch() {
  const showMarkings = useBuilding1Store((state) => state.showFootballMarkings);
  const showGoals = useBuilding1Store((state) => state.showGoals);
  return (
    <group name="FOOTBALL_PITCH">
      <mesh position={[0, 0.25, 0]} receiveShadow>
        <boxGeometry args={[PITCH_LENGTH + 4, 0.18, PITCH_WIDTH + 3]} />
        <meshStandardMaterial color={FIELD_GREEN} roughness={0.96} />
      </mesh>
      {showMarkings && (
        <group name="FOOTBALL_MARKINGS">
          <RectLine width={PITCH_LENGTH} depth={PITCH_WIDTH} />
          <Line points={[[0, 0.32, -PITCH_WIDTH / 2], [0, 0.32, PITCH_WIDTH / 2]]} color={MARKING} lineWidth={1.7} />
          <CircleLine radius={4.7} />
          <mesh position={[0, 0.33, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.12, 18]} /><meshBasicMaterial color={MARKING} /></mesh>
          <RectLine width={11.5} depth={22} x={-(PITCH_LENGTH / 2 - 5.75)} />
          <RectLine width={11.5} depth={22} x={PITCH_LENGTH / 2 - 5.75} />
          <RectLine width={4.8} depth={10} x={-(PITCH_LENGTH / 2 - 2.4)} />
          <RectLine width={4.8} depth={10} x={PITCH_LENGTH / 2 - 2.4} />
          <mesh position={[-PITCH_LENGTH / 2 + 9, 0.33, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.10, 16]} /><meshBasicMaterial color={MARKING} /></mesh>
          <mesh position={[PITCH_LENGTH / 2 - 9, 0.33, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.10, 16]} /><meshBasicMaterial color={MARKING} /></mesh>
        </group>
      )}
      {showGoals && <><Goal side={-1} /><Goal side={1} /></>}
    </group>
  );
}

function RunningTrack() {
  const showLanes = useBuilding1Store((state) => state.showTrackLanes);
  const geometry = useMemo(() => makeTrackGeometry(), []);
  const laneLines = useMemo(() => {
    const lanes = 6;
    return Array.from({ length: lanes + 1 }, (_, index) => {
      const t = index / lanes;
      const r = INNER_RADIUS + TRACK_WIDTH * t;
      return stadiumLoopPoints(INNER_STRAIGHT_HALF, r, 0.34, 48);
    });
  }, []);
  return (
    <group name="ATHLETICS_TRACK">
      <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.27, 0]} receiveShadow>
        <meshStandardMaterial color={TRACK} roughness={0.92} side={THREE.DoubleSide} />
      </mesh>
      {showLanes && laneLines.map((points, index) => <Line key={index} points={points} color={TRACK_LINE} lineWidth={index === 0 || index === laneLines.length - 1 ? 1.8 : 1.0} />)}
      {showLanes && <Line points={[[15, 0.35, INNER_RADIUS], [15, 0.35, OUTER_RADIUS]]} color={TRACK_LINE} lineWidth={2.0} />}
    </group>
  );
}

function AssemblyZones() {
  const show = useBuilding1Store((state) => state.showAssemblyZones);
  if (!show) return null;
  return (
    <group name="ASSEMBLY_ZONES">
      {ASSEMBLY_ZONES.map((zone) => (
        <group key={zone.id} position={[zone.offset[0], 0.39, zone.offset[1]]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[17.5, 12.5]} />
            <meshBasicMaterial color="#30d984" transparent opacity={0.095} depthWrite={false} />
          </mesh>
          <Line points={[[-8.75, 0.015, -6.25], [8.75, 0.015, -6.25], [8.75, 0.015, 6.25], [-8.75, 0.015, 6.25], [-8.75, 0.015, -6.25]]} color="#7fffc0" lineWidth={1.1} dashed dashSize={0.7} gapSize={0.45} />
          <Html center position={[0, 1.0, 0]} distanceFactor={22}>
            <div className="assembly-zone-label"><strong>ZONE {zone.id}</strong><span>{zone.capacity} คน</span></div>
          </Html>
        </group>
      ))}
    </group>
  );
}

function FloodLight({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]} name="FIELD_FLOODLIGHT">
      <mesh position={[0, 6.1, 0]} castShadow><cylinderGeometry args={[0.10, 0.16, 12.2, 10]} /><meshStandardMaterial color="#c9d0d2" metalness={0.68} roughness={0.32} /></mesh>
      <mesh position={[0, 12.1, 0]}><boxGeometry args={[3.4, 0.25, 0.32]} /><meshStandardMaterial color="#89949a" metalness={0.62} roughness={0.34} /></mesh>
      {[-1.2, -0.4, 0.4, 1.2].map((x) => (
        <mesh key={x} position={[x, 11.92, -0.22]} rotation={[-0.25, 0, 0]}>
          <boxGeometry args={[0.58, 0.38, 0.22]} />
          <meshStandardMaterial color="#effcff" emissive="#b8e7ff" emissiveIntensity={1.2} roughness={0.25} />
        </mesh>
      ))}
    </group>
  );
}

function FieldEnvironment() {
  const showLights = useBuilding1Store((state) => state.showFieldLights);
  return (
    <group name="FIELD_ENVIRONMENT">
      <mesh position={[0, 0.07, 0]} receiveShadow>
        <boxGeometry args={[TRACK_LENGTH + 10, 0.14, TRACK_DEPTH + 10]} />
        <meshStandardMaterial color="#c9cec7" roughness={0.98} />
      </mesh>
      <mesh position={[0, 0.12, -(OUTER_RADIUS + 3.7)]} receiveShadow><boxGeometry args={[TRACK_LENGTH + 4, 0.2, 2.4]} /><meshStandardMaterial color={CURB} roughness={0.88} /></mesh>
      <mesh position={[0, 0.12, OUTER_RADIUS + 3.7]} receiveShadow><boxGeometry args={[TRACK_LENGTH + 4, 0.2, 2.4]} /><meshStandardMaterial color={CURB} roughness={0.88} /></mesh>
      {showLights && (
        <>
          <FloodLight position={[-OUTER_STRAIGHT_HALF - OUTER_RADIUS - 4, 0, -OUTER_RADIUS - 2.5]} rotation={0.4} />
          <FloodLight position={[OUTER_STRAIGHT_HALF + OUTER_RADIUS + 4, 0, -OUTER_RADIUS - 2.5]} rotation={-0.4} />
          <FloodLight position={[-OUTER_STRAIGHT_HALF - OUTER_RADIUS - 4, 0, OUTER_RADIUS + 2.5]} rotation={Math.PI - 0.4} />
          <FloodLight position={[OUTER_STRAIGHT_HALF + OUTER_RADIUS + 4, 0, OUTER_RADIUS + 2.5]} rotation={Math.PI + 0.4} />
        </>
      )}
    </group>
  );
}

export function SportsFieldModel() {
  const show = useBuilding1Store((state) => state.showSportsField);
  const showLabels = useBuilding1Store((state) => state.showFieldLabels);
  if (!show) return null;

  return (
    <group name="SPORTS_FIELD_ASSEMBLY_MODEL" position={[FIELD_CENTER[0], 0, FIELD_CENTER[2]]}>
      <FieldEnvironment />
      <RunningTrack />
      <FootballPitch />
      <AssemblyZones />
      {showLabels && (
        <Html center position={[0, 4.2, 0]} distanceFactor={20}>
          <div className="field-world-label field-world-label-primary">
            <strong>สนามฟุตบอล · จุดรวมพลหลัก</strong>
            <span>6 โซน × 500 คน = 3,000 คน</span>
          </div>
        </Html>
      )}
      <Html center position={[0, 1.15, OUTER_RADIUS + 5.1]} distanceFactor={22}>
        <div className="field-entry-label"><strong>ASSEMBLY GATE</strong><span>จุดรับคนจากตึก 1</span></div>
      </Html>
    </group>
  );
}
