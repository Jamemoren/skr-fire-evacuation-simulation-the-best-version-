import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fail = [];
let checks = 0;
const mustFile = (path) => { checks += 1; if (!existsSync(resolve(root, path))) fail.push(`ไม่พบ ${path}`); };
const mustText = (path, pattern, label) => {
  checks += 1;
  const text = readFileSync(resolve(root, path), "utf8");
  if (!pattern.test(text)) fail.push(`ไม่พบ ${label} ใน ${path}`);
};
const mustNotText = (path, pattern, label) => {
  checks += 1;
  const text = readFileSync(resolve(root, path), "utf8");
  if (pattern.test(text)) fail.push(`ยังพบ ${label} ใน ${path}`);
};

[
  "src/components/DaylightEnvironment.tsx",
  "src/components/AppErrorBoundary.tsx",
  "src/simulation/types.ts",
  "src/simulation/walkable.ts",
  "src/simulation/graph.ts",
  "src/simulation/runtime.ts",
  "src/simulation/simulationStore.ts",
  "src/simulation/SimulationScene.tsx",
  "src/simulation/SimulationDashboard.tsx",
  "src/simulation/operationalReadiness.ts",
  "public/assets/evacuation-physical-route.png",
  "examples/building1-semantic-map.json",
].forEach(mustFile);

mustText("src/components/DaylightEnvironment.tsx", /<Sky/, "physical clear-sky environment");
mustText("src/main.tsx", /AppErrorBoundary[\s\S]*<AppErrorBoundary>[\s\S]*<App\s*\/>/, "app-level recovery boundary");
mustText("src/components/AppErrorBoundary.tsx", /การกู้คืนระบบ[\s\S]*window\.location\.reload/, "safe recovery screen");
mustText("src/components/DaylightEnvironment.tsx", /mieCoefficient/, "stable single-pass atmospheric sky");
mustText("src/simulation/FireEffects.tsx", /const lobes[\s\S]*cell.height[\s\S]*shaderMaterial/, "instanced multi-layer visible fire cells");
mustText("src/simulation/FireEffects.tsx", /const cycle[\s\S]*smoke.current.setMatrixAt/, "animated smoke cells");
mustText("src/simulation/FireEffects.tsx", /ref={glow}[\s\S]*circleGeometry/, "bounded ground glow matching the flame footprint");
mustText("src/simulation/walkable.ts", /pointInsideWalkableCorridor/, "wall collision corridor guard");
mustText("src/simulation/walkable.ts", /pointClearsExteriorBuilding/, "solid end-tower exterior guard");
mustText("src/simulation/runtime.ts", /collisionCorrections/, "wall collision runtime metric");
mustText("src/simulation/runtime.ts", /activeEdgeCounts/, "crowd density speed model");
mustText("src/simulation/runtime.ts", /lookAheadIds/, "future hazard look-ahead");
mustText("src/simulation/graph.ts", /marginalSystemArrivalScore/, "system-level marginal arrival routing");
mustText("src/simulation/graph.ts", /for \(let person = 0; person < count; person \+= 1\)/, "person-by-person route allocation");
mustText("src/building1/Building1DigitalTwin.tsx", /openForEvacuation/, "physical opening classroom doors");
mustText("src/building1/Building1DigitalTwin.tsx", /Math\.PI \* 0\.96/, "door leaf folds clear of evacuation lane");
mustText("src/building1/Building1DigitalTwin.tsx", /REAL_STAIR_VOID/, "physical stairwell floor openings");
mustText("src/building1/Building1DigitalTwin.tsx", /PHYSICAL_DOOR_OPENING/, "enclosed tower door openings");
mustText("src/building1/Building1DigitalTwin.tsx", /LOWER_ACCESS_LANDING/, "continuous lower stair landing");
mustText("src/building1/Building1DigitalTwin.tsx", /UPPER_ACCESS_LANDING/, "continuous upper stair landing");
mustText("src/building1/Building1DigitalTwin.tsx", /CORE_LIFT_X/, "separated central lift bank");
mustText("src/building1/Building1DigitalTwin.tsx", /CurvedCoreSlab[\s\S]*CurvedCoreOpenRailing/, "open curved central connector");
mustText("src/simulation/studentGeometry.ts", /StudentGender/, "mixed-gender student geometry");
mustText("src/simulation/studentGeometry.ts", /oval\(\[\.011, \.006, \.003\]\)[\s\S]*oval\(\[\.012, \.021, \.014\]\)/, "student eyes and face details");
mustText("src/simulation/runtime.ts", /updateFireAwareness/, "local human fire awareness");
mustText("src/simulation/runtime.ts", /smokeDetectionThreshold/, "individual smoke smell threshold");
mustText("src/simulation/runtime.ts", /visibleSmoke/, "visible smoke perception");
mustText("src/simulation/runtime.ts", /visibilitySlowdown/, "smoke visibility walking response");
mustText("src/simulation/graph.ts", /source.intensity[\s\S]*cueReach/, "radiant heat field beyond visible flame");
mustText("src/simulation/graph.ts", /DEFAULT_HARD_BLOCK_TEMPERATURE_C[\s\S]*modeledTemperatureFromHeat/, "simplified modeled-temperature conversion");
mustText("src/simulation/graph.ts", /export function dijkstraPath[\s\S]*return findPath\([\s\S]*excluded, 0\)/, "Dijkstra implementation using the production dynamic edge cost");
mustText("src/simulation/graph.ts", /hardBlockTemperatureC[\s\S]*return Infinity[\s\S]*thermalPenalty/, "hard thermal edge blocking and weighted thermal route cost");
mustText("src/simulation/runtime.ts", /thermalLookAheadEdges[\s\S]*thermalBlocked[\s\S]*thermalRerouteCount/, "configurable thermal look-ahead and reroute accounting");
mustText("src/simulation/SimulationDashboard.tsx", /แบบจำลองความร้อนเชิงประมาณ[\s\S]*อุณหภูมิห้ามผ่าน \(°C\)[\s\S]*จำนวนช่วงเส้นทางที่ตรวจล่วงหน้า/, "operator thermal controls with scientific-honesty label");
mustText("src/simulation/runtime.ts", /p95Arrival[\s\S]*blockedThermalEdges[\s\S]*smokeAffectedEdges[\s\S]*maxQueue/, "derived evacuation and thermal performance metrics");
mustText("src/simulation/runtime.ts", /heatDetectionThreshold/, "individual thermal perception threshold");
mustText("src/simulation/runtime.ts", /thermalRetreat/, "pre-contact thermal retreat response");
mustText("src/simulation/runtime.ts", /protectivePosture/, "realistic low-smoke protective posture");
mustText("src/components/DaylightEnvironment.tsx", /survival|SoftCloud|mieCoefficient/i, "upgraded atmospheric sky");
mustText("src/building1/Building1DigitalTwin.tsx", /ARCHITECTURAL_MODEL_REFINEMENT/, "school architectural realism upgrade");
mustText("src/simulation/SimulationDashboard.tsx", /การวางแผนเส้นทางตามความเสี่ยง/, "risk-aware route planning UI");
mustText("src/simulation/SimulationDashboard.tsx", /activeSpreadFireCount[\s\S]*travellingFireFrontCount[\s\S]*กำลังลาม/, "separate travelling fire-front and ignited-object counts");
mustText("src/simulation/graph.ts", /routeIsPhysicallyValid[\s\S]*topologyAllowed[\s\S]*pointInsideWalkableCorridor/, "hard physical route validation");
mustText("src/simulation/runtime.ts", /forecastRouteSurvival[\s\S]*projectedSmokeDose[\s\S]*projectedHeatDose[\s\S]*survivable/, "agent-specific survival forecast");
mustText("src/simulation/runtime.ts", /compareSurvivalForecast[\s\S]*a\.survivable[\s\S]*a\.eta - b\.eta/, "lexicographic safe-then-fast route selection");
mustText("src/simulation/runtime.ts", /kShortestPaths[\s\S]*routeIsPhysicallyValid[\s\S]*proactiveSafeOptimization/, "continuous multi-route safe optimization");
mustText("src/simulation/runtime.ts", /riskAversion/, "individual human risk profiles");
mustText("src/simulation/runtime.ts", /hasExitedBuilding/, "physical exit-portal state guard");
mustText("src/simulation/runtime.ts", /touchesDoorPortal/, "door lateral-clipping guard");
mustText("src/simulation/runtime.ts", /hasPassedRoomDoor/, "classroom physical-door state guard");
mustText("src/simulation/runtime.ts", /agent\.flameContactSeconds = currentRisk\.blocked[\s\S]*DIRECT_FLAME_INCAPACITATION_SECONDS[\s\S]*incapacitateAgent/, "continuous direct-flame contact guard independent of perception");
mustNotText("src/simulation/runtime.ts", /incapacitateAgent\(agent, agent\.heatDose|incapacitateAgent\(agent, .*ควันสะสม/, "remote smoke or heat incapacitation");
mustText("src/simulation/runtime.ts", /MAX_OBJECT_CONNECTED_FIRE_PATCHES = 16[\s\S]*MAX_FIRE_SPREAD_GENERATION = 12[\s\S]*MAX_HORIZONTAL_FIRE_TRANSFER_DISTANCE = 12[\s\S]*MAX_STAIR_FIRE_TRANSFER_DISTANCE = 11\.5[\s\S]*transmissionCadence[\s\S]*lastFireTransmissionAt < transmissionCadence/, "dense object-connected multi-patch fire spread");
mustText("src/simulation/runtime.ts", /spreadPath[\s\S]*spreadTravelStartTime[\s\S]*startTime: this\.time \+ travelDuration[\s\S]*positionAlongPolyline/, "continuous connected fire-front travel before target ignition");
mustText("src/simulation/FireEffects.tsx", /for \(const cell of flameCellsAt\(fire, time\)\)[\s\S]*floorOffset[\s\S]*setMatrixAt/, "shared flame cells rendered in every quality tier with matching floor offsets");
mustText("src/simulation/fireField.ts", /flameCellsAt[\s\S]*spreadTravelStartTime[\s\S]*cellContactRadius[\s\S]*bodySegmentTouchesFlame/, "visible cell contact and persistent continuous spread");
mustText("src/simulation/runtime.ts", /preferredSpacing/, "pedestrian personal-space steering");
mustText("src/simulation/runtime.ts", /setWalkingSpeed[\s\S]*ratio[\s\S]*reroutePathCache\.clear/, "live unlimited bot-speed update");
mustText("src/simulation/simulationStore.ts", /setWalkingSpeed[\s\S]*normalizeWalkingSpeed[\s\S]*evacuationRuntime\.setWalkingSpeed/, "uncapped walking-speed store control");
mustText("src/simulation/SimulationDashboard.tsx", /sim-unbounded-speed[\s\S]*ความเร็วการเดิน[\s\S]*aria-label="Walking speed"[\s\S]*min="0\.01"/, "no-upper-limit walking-speed input");
mustText("src/simulation/simulationStore.ts", /FIRE_PATTERN_STORAGE_KEY/, "persistent fire and smoke pattern memory");
mustText("src/simulation/simulationStore.ts", /sanitizeStoredFireSource[\s\S]*finiteBetween[\s\S]*localStorage\.setItem[\s\S]*catch/, "validated and failure-safe local fire pattern storage");
mustText("src/simulation/SimulationScene.tsx", /incapacitatedAt/, "animated fallen student pose");
mustText("src/simulation/SimulationScene.tsx", /simulatedSlice[\s\S]*maxSubstep[\s\S]*substeps[\s\S]*evacuationRuntime\.step\(substepDt\)/, "high-speed fixed micro-substep integration");
mustText("src/simulation/SimulationScene.tsx", /PER_AGENT_CAMERA_FRUSTUM[\s\S]*setFromProjectionMatrix[\s\S]*intersectsSphere/, "offscreen student instance compaction");
mustText("src/simulation/graph.ts", /stairExitDoorId/, "shared stair-exit portal routing");
mustText("src/simulation/SimulationDashboard.tsx", /evacuation-physical-route\.png/, "illustrated evacuation workflow");
mustText("src/styles.css", /White simulation command interface/, "white simulator UI");
mustText("src/simulation/SimulationDashboard.tsx", /ลดเวลาอพยพโดยรวม/, "system-level route allocation UI label");
mustText("src/simulation/operationalReadiness.ts", /evaluateOperationalReadiness[\s\S]*routeIsPhysicallyValid[\s\S]*validRoutes === TOTAL_CLASSROOMS/, "browser-side physical route pre-flight");
mustText("src/simulation/semanticGraph.ts", /createEvacuationGraph[\s\S]*graph\.nodes\.map[\s\S]*graph\.edges\.map/, "semantic map mirrors simulation graph");
mustText("src/simulation/SimulationDashboard.tsx", /ความพร้อมก่อนเริ่มการจำลอง[\s\S]*disabled=\{!preflightReady\}/, "fail-closed operational readiness UI");
mustText("src/styles.css", /sim-readiness-strip[\s\S]*app-fatal-shell/, "readiness and recovery visual system");
mustText("index.html", /โรงเรียนสวนกุหลาบวิทยาลัย รังสิต[\s\S]*skr-school-emblem\.png/, "correct school metadata and emblem");
mustText("src/components/SceneCanvas.tsx", /firstPersonLook[\s\S]*event\.button\s*!==\s*2[\s\S]*setPointerCapture[\s\S]*orientation\.y[\s\S]*orientation\.x/, "right-drag first-person camera look");
mustText("src/components/SceneCanvas.tsx", /onContextMenu[\s\S]*event\.preventDefault/, "right-click menu suppression on the 3D canvas");
mustText("src/components/SceneCanvas.tsx", /mouseButtons=\{\{[\s\S]*LEFT:\s*undefined[\s\S]*RIGHT:\s*THREE\.MOUSE\.ROTATE/, "left click stays available for actions; right button controls camera look");
mustText("src/components/SceneCanvas.tsx", /CatmullRomCurve3[\s\S]*Quintic smootherstep[\s\S]*getPointAt/, "arc-length cinematic camera with smooth acceleration");
mustText("src/components/SceneCanvas.tsx", /introHandoffFocusToken[\s\S]*dataset\.introState = "held"/, "jump-free cinematic camera handoff");
mustText("src/components/cinematicConfig.ts", /CINEMATIC_INTRO_END_POSITION[\s\S]*CINEMATIC_INTRO_END_TARGET/, "shared cinematic final pose");
mustText("src/building1/Building1DigitalTwin.tsx", /StaticBoxBatcher[\s\S]*new THREE\.InstancedMesh[\s\S]*StaticDrawUsage/, "GPU instancing for repeated architectural meshes");
mustText("src/building1/Building1DigitalTwin.tsx", /simulationStatus[\s\S]*doorsSettleAt[\s\S]*560[\s\S]*savedDraws[\s\S]*settleDelay/, "door-settle batching without removing door animation");
mustText("src/building1/Building1DigitalTwin.tsx", /PhysicalRailSegment[\s\S]*cylinderGeometry/, "batchable physical stair handrails");
mustText("src/building1/building1Data.ts", /STAIR_FLIGHT_CENTER_OFFSET[\s\S]*STAIR_FIRST_STEP_Z[\s\S]*STAIR_MID_LANDING_Z[\s\S]*STAIR_SECOND_STEP_Z/, "shared physical stair layout");
mustText("src/building1/Building1DigitalTwin.tsx", /B1_SUPPORTED_RISER_FLIGHT_1[\s\S]*cumulativeRise[\s\S]*B1_SUPPORTED_RISER_FLIGHT_2/, "aligned stair risers");
mustText("src/building1/building1Data.ts", /CENTRAL_STAIR_FLOOR_OPENING_SIZE[\s\S]*CENTRAL_STAIR_ACCESS_LANDING_WIDTH[\s\S]*CENTRAL_STAIR_ACCESS_LANDING_DEPTH/, "expanded central-stair void and landings");
mustText("src/building1/building1Data.ts", /CORE_OPEN_CONNECTOR_RADIUS[\s\S]*CORE_OPEN_CONNECTOR_ANGLE[\s\S]*CORE_OPEN_CONNECTOR_CENTER/, "shared open-balcony connector geometry");
mustText("src/building1/building1Data.ts", /CORE_CURVED_STRUCTURAL_RADIUS[\s\S]*CORE_CURVED_CANTILEVER_RADIUS/, "exterior-only curved cantilever dimensions");
mustText("src/building1/Building1DigitalTwin.tsx", /CurvedCoreSlab[\s\S]*shape\.absarc[\s\S]*shape\.holes\.push[\s\S]*CurvedCoreOpenRailing/, "true curved exterior slab and open railing");
mustText("src/building1/Building1DigitalTwin.tsx", /CurvedCoreOpenRailing[\s\S]*courtyardWingClearance[\s\S]*pinkCourtyardEdgeZ[\s\S]*blueCourtyardEdgeX[\s\S]*railAngleLength/, "courtyard-only curved railing that clears both interior wings");
mustText("src/building1/Building1DigitalTwin.tsx", /CurvedCoreCantilever[\s\S]*NON_NAVIGABLE_EXTERIOR[\s\S]*DRIP_EDGE/, "non-navigable circular exterior projection");
mustText("src/building1/Building1DigitalTwin.tsx", /B1_CORE_ENCLOSURE[\s\S]*B1_CORE_REAR_WALL[\s\S]*B1_CORE_EAST_WALL_BAND/, "core enclosure aligned with classroom boundaries");
mustText("src/building1/Building1DigitalTwin.tsx", /B1_CURVED_CORE_ROOF[\s\S]*B1_CORE_OPEN_CURVE_ROOF/, "open-railed curved central-core roof edge");
mustText("src/building1/Building1DigitalTwin.tsx", /B1_REAR_JUNCTION_FULL_HEIGHT_CLOSURE[\s\S]*B1_REAR_JUNCTION_SOUTH_WALL[\s\S]*B1_REAR_JUNCTION_EAST_RETURN/, "full-height rear junction wall closure");
mustText("src/building1/Building1DigitalTwin.tsx", /B1_REAR_JUNCTION_SOUTH_FOUNDATION_SEAL[\s\S]*B1_REAR_JUNCTION_EAST_FOUNDATION_SEAL/, "continuous rear junction foundation seal");
mustText("src/building1/Building1DigitalTwin.tsx", /B1_REAR_JUNCTION_RECTANGULAR_ROOF_CLOSURE[\s\S]*rearJunctionWidth[\s\S]*rearJunctionDepth/, "rectangular rear-junction roof closure plate");
mustText("src/simulation/graph.ts", /edge-pink-inner-junction[\s\S]*CORE_OPEN_CONNECTOR_CENTER/, "navigation crosses the open curved connector");
mustNotText("src/building1/Building1DigitalTwin.tsx", /CORE_CURVED_FACADE|SEALED_WALL|CURVED_WALL_JOINT/, "no wall on the curved exterior balcony");
mustNotText("src/building1/Building1DigitalTwin.tsx", /CENTRAL_CORE_CENTER|B1_CORE_CLEAR_CONNECTOR/, "removed central rooftop drum and square connector projection");
mustNotText("src/building1/Building1DigitalTwin.tsx", /B1_MAIN_ENTRANCE_CANOPY/, "floating entrance glass canopy");
mustText("src/components/SceneCanvas.tsx", /if \(workMode !== "editor"\) return/, "ordinary simulation clicks do not invoke editor actions");
mustText("src/components/SceneCanvas.tsx", /ControlLeft[\s\S]*requestPointerLock[\s\S]*ctrlLockActive/, "Roblox-style Ctrl pointer lock camera");
mustText("src/components/SceneCanvas.tsx", /pointerlockchange[\s\S]*exitPointerLock/, "Ctrl lock lifecycle and Escape release");

const map = JSON.parse(readFileSync(resolve(root, "examples/building1-semantic-map.json"), "utf8"));
const classrooms = map.annotations.filter((item) => item.type === "classroom");
const stairs = map.annotations.filter((item) => item.type === "stair");
const zones = map.annotations.filter((item) => item.type === "assembly-area");
const people = classrooms.reduce((sum, item) => sum + Number(item.peopleCount || 0), 0);
const capacity = zones.reduce((sum, item) => sum + Number(item.capacity || 0), 0);
checks += 5;
if (classrooms.length !== 96) fail.push(`ห้องเรียนต้อง 96 แต่ได้ ${classrooms.length}`);
if (stairs.length !== 27) fail.push(`Stair nodes ต้อง 27 แต่ได้ ${stairs.length}`);
if (zones.length !== 6) fail.push(`Assembly zones ต้อง 6 แต่ได้ ${zones.length}`);
if (people !== 3000) fail.push(`ประชากร target ต้อง 3000 แต่ได้ ${people}`);
if (capacity !== 3000) fail.push(`สนามต้องรองรับรวม 3000 แต่ได้ ${capacity}`);

const floorPopulation = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 2, 0]));
classrooms.forEach((room) => { floorPopulation[room.floor] = (floorPopulation[room.floor] || 0) + Number(room.peopleCount || 0); });
checks += 8;
for (let floor = 2; floor <= 9; floor += 1) {
  if (floorPopulation[floor] !== 375) fail.push(`ชั้น ${floor} ต้องมีประชากร 375 คน แต่ได้ ${floorPopulation[floor]}`);
}

if (fail.length) {
  console.error("Feature QA ไม่ผ่าน:\n" + fail.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`Feature QA ผ่าน: ${checks} checks · Fire/Smoke FX · Route Planning · Wall Collision Guard · Physical Door Openings`);
