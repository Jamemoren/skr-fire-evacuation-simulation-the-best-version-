import * as THREE from "three";
import type { Vec3 } from "../../types";
import { INTRO_SPARK_POINT } from "./introCamera";
import { INTRO_COLORS as C, type IntroData, type IntroRoute, type Polyline } from "./introData";
import {
  BEAM_FRAG,
  DOME_FRAG,
  DOME_VERT,
  FLARE_FRAG,
  GLOW_LINE_FRAG,
  GLOW_LINE_VERT,
  GRID_FRAG,
  PLANE_VERT,
  POINTS_FRAG,
  POINTS_VERT,
  RING_FRAG,
  SCAN_FRAG,
} from "./introShaders";
import { clamp01, easeInOutCubic, easeOutCubic, envelope, ramp, type IntroEffectLevel } from "./introTimeline";

// ---------------------------------------------------------------------------
// Story timing (seconds). Kept here so every layer reads from one table.
// ---------------------------------------------------------------------------
export const SCAN_START = 2.05;
export const SCAN_END = 4.7;
const SCAN_TOP = 46;

/** Local height of the reveal scan plane. Below it the real model is visible. */
export function scanHeightAt(t: number): number {
  if (t < SCAN_START) return 0.03;
  if (t >= SCAN_END + 0.05) return 1e5;
  return THREE.MathUtils.lerp(-0.2, SCAN_TOP, easeInOutCubic((t - SCAN_START) / (SCAN_END - SCAN_START)));
}

const color = (hex: string) => new THREE.Color(hex);

interface Shared {
  uTime: { value: number };
  uMotion: { value: number };
  uResolution: { value: THREE.Vector2 };
  uSizeScale: { value: number };
  uMaxSize: { value: number };
  uScanY: { value: number };
}

interface GlowOptions {
  width: number;
  depthTest?: boolean;
  depthBias?: number;
  trail?: { speed: number; length: number; base: number };
  hot?: number;
  scanBoost?: number;
  belowScan?: number;
  renderOrder?: number;
}

type GlowMaterial = THREE.ShaderMaterial & {
  uniforms: Record<"uOpacity" | "uWidth" | "uHot" | "uBase" | "uTrail" | "uTrailSpeed" | "uTrailLen" | "uScanBoost" | "uBelowScan" | "uDepthBias", { value: number }>;
};

function polylineDistances(points: Vec3[]) {
  const d = [0];
  for (let i = 1; i < points.length; i += 1) {
    d.push(d[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]));
  }
  return d;
}

/** Screen-space thick lines with a gaussian core+halo profile (one draw call per layer). */
function createGlowLines(lines: Polyline[], shared: Shared, options: GlowOptions) {
  let segments = 0;
  for (const line of lines) segments += Math.max(0, line.points.length - 1);
  const aA = new Float32Array(segments * 12);
  const aB = new Float32Array(segments * 12);
  const aCorner = new Float32Array(segments * 8);
  const aTiming = new Float32Array(segments * 16);
  const aPath = new Float32Array(segments * 8);
  const aColor = new Float32Array(segments * 12);
  const position = new Float32Array(segments * 12);
  const index = new Uint32Array(segments * 6);
  const corners = [[-1, 0], [1, 0], [-1, 1], [1, 1]];
  const tint = new THREE.Color();
  let s = 0;
  for (const line of lines) {
    const dist = polylineDistances(line.points);
    const total = dist[dist.length - 1] || 1;
    tint.set(line.color);
    for (let i = 1; i < line.points.length; i += 1) {
      const a = line.points[i - 1];
      const b = line.points[i];
      // Each segment draws during its share of the polyline's draw window.
      const start = line.drawStart + line.drawDuration * (dist[i - 1] / total);
      const duration = Math.max(0.001, line.drawDuration * ((dist[i] - dist[i - 1]) / total));
      for (let v = 0; v < 4; v += 1) {
        const o = s * 4 + v;
        aA.set(a, o * 3);
        aB.set(b, o * 3);
        position.set(v < 2 ? a : b, o * 3);
        aCorner.set(corners[v], o * 2);
        aTiming.set([start, duration, dist[i - 1], dist[i]], o * 4);
        aPath.set([total, line.phase ?? 0], o * 2);
        aColor.set([tint.r, tint.g, tint.b], o * 3);
      }
      index.set([s * 4, s * 4 + 2, s * 4 + 1, s * 4 + 1, s * 4 + 2, s * 4 + 3], s * 6);
      s += 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aA", new THREE.BufferAttribute(aA, 3));
  geometry.setAttribute("aB", new THREE.BufferAttribute(aB, 3));
  geometry.setAttribute("aCorner", new THREE.BufferAttribute(aCorner, 2));
  geometry.setAttribute("aTiming", new THREE.BufferAttribute(aTiming, 4));
  geometry.setAttribute("aPath", new THREE.BufferAttribute(aPath, 2));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(aColor, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const material = new THREE.ShaderMaterial({
    vertexShader: GLOW_LINE_VERT,
    fragmentShader: GLOW_LINE_FRAG,
    uniforms: {
      uTime: shared.uTime,
      uMotion: shared.uMotion,
      uResolution: shared.uResolution,
      uScanY: shared.uScanY,
      uOpacity: { value: 0 },
      uWidth: { value: options.width },
      uDepthBias: { value: options.depthBias ?? 0 },
      uTrail: { value: options.trail ? 1 : 0 },
      uTrailSpeed: { value: options.trail?.speed ?? 0 },
      uTrailLen: { value: options.trail?.length ?? 1 },
      uBase: { value: options.trail?.base ?? 1 },
      uHot: { value: options.hot ?? 0.5 },
      uScanBoost: { value: options.scanBoost ?? 0 },
      uBelowScan: { value: options.belowScan ?? 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: options.depthTest ?? false,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    fog: false,
  }) as GlowMaterial;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = options.renderOrder ?? 20;
  return { mesh, material, baseWidth: options.width };
}

type PointsKind = "STATIC" | "SPARKS" | "DUST" | "DYNAMIC";
type PointsMaterial = THREE.ShaderMaterial & { uniforms: Record<"uOpacity" | "uHot", { value: number }> };

function createPoints(kind: PointsKind, count: number, shared: Shared, options: { depthTest?: boolean; hot?: number; renderOrder?: number } = {}) {
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(count * 3);
  const aColor = new Float32Array(count * 3);
  const aSize = new Float32Array(count);
  const aParams = new Float32Array(count * 4);
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(aColor, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute("aParams", new THREE.BufferAttribute(aParams, 4));
  let aVelocity: Float32Array | null = null;
  if (kind === "SPARKS") {
    aVelocity = new Float32Array(count * 3);
    geometry.setAttribute("aVelocity", new THREE.BufferAttribute(aVelocity, 3));
  }
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const material = new THREE.ShaderMaterial({
    vertexShader: POINTS_VERT,
    fragmentShader: POINTS_FRAG,
    defines: { [kind]: "" },
    uniforms: {
      uTime: shared.uTime,
      uMotion: shared.uMotion,
      uSizeScale: shared.uSizeScale,
      uMaxSize: shared.uMaxSize,
      uOpacity: { value: 0 },
      uHot: { value: options.hot ?? 0.6 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: options.depthTest ?? false,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    fog: false,
  }) as PointsMaterial;
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = options.renderOrder ?? 30;
  return { points, material, geometry, position, aColor, aSize, aParams, aVelocity, count };
}

type PlaneMaterial = THREE.ShaderMaterial & { uniforms: Record<string, { value: unknown }> };

function createGroundPlane(size: number, fragmentShader: string, uniforms: Record<string, { value: unknown }>, options: { depthTest?: boolean; renderOrder?: number } = {}) {
  const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader: PLANE_VERT,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: options.depthTest ?? true,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }) as PlaneMaterial;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.frustumCulled = false;
  mesh.renderOrder = options.renderOrder ?? 10;
  return { mesh, material };
}

interface RingSpec {
  center: Vec3;
  start: number;
  duration: number;
  maxRadius: number;
  minRadius?: number;
  thickness: number;
  colorA: string;
  colorB: string;
  peak?: number;
  /** Repeat period (s) for pulses; omitted = one shot. */
  period?: number;
  until?: number;
  depthTest?: boolean;
}

function createRing(spec: RingSpec) {
  const size = spec.maxRadius * 2 + spec.thickness * 8;
  const { mesh, material } = createGroundPlane(size, RING_FRAG, {
    uRadius: { value: 0 },
    uThickness: { value: spec.thickness },
    uAlpha: { value: 0 },
    uColorA: { value: color(spec.colorA) },
    uColorB: { value: color(spec.colorB) },
  }, { depthTest: spec.depthTest ?? true, renderOrder: 12 });
  mesh.position.set(spec.center[0], spec.center[1], spec.center[2]);
  const warmed = { done: false };
  const update = (t: number, motion: number) => {
    let alpha = 0;
    let radius = 0;
    if (spec.period) {
      const active = envelope(t, spec.start, spec.start + 0.25, (spec.until ?? 99) - 0.35, spec.until ?? 99);
      const phase = ((motion - spec.start) / spec.period) % 1;
      const p = phase < 0 ? phase + 1 : phase;
      radius = THREE.MathUtils.lerp(spec.minRadius ?? 0, spec.maxRadius, easeOutCubic(p));
      alpha = active * Math.sin(Math.PI * p) * (spec.peak ?? 1);
    } else {
      const p = (t - spec.start) / spec.duration;
      if (p > 0 && p < 1) {
        radius = THREE.MathUtils.lerp(spec.minRadius ?? 0, spec.maxRadius, easeOutCubic(p));
        alpha = (1 - p) ** 1.4 * smoothIn(p) * (spec.peak ?? 1);
      }
    }
    material.uniforms.uRadius.value = radius;
    material.uniforms.uAlpha.value = alpha;
    mesh.visible = alpha > 0.002 || !warmed.done;
  };
  return { mesh, material, update, warmed };
}
const smoothIn = (p: number) => clamp01(p / 0.06);

function createBillboard(fragmentShader: string, uniforms: Record<string, { value: unknown }>, renderOrder = 40, depthTest = true) {
  const material = new THREE.ShaderMaterial({
    vertexShader: PLANE_VERT,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    fog: false,
  }) as PlaneMaterial;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return { mesh, material };
}

/** CPU-driven particles flowing along real graph routes (a few hundred at most). */
class RouteFlow {
  readonly layer: ReturnType<typeof createPoints>;
  private readonly routes: Array<{ xyz: Float32Array; cum: Float32Array; length: number }>;
  private readonly particles: Array<{ route: number; offset: number; speed: number }>;
  private readonly scratch = new THREE.Vector3();

  constructor(routes: Array<{ points: Vec3[] }>, perRoute: number, palette: string[], shared: Shared, size: number, speed: number) {
    this.routes = routes.map((route) => {
      const xyz = new Float32Array(route.points.flat());
      const cum = new Float32Array(polylineDistances(route.points));
      return { xyz, cum, length: cum[cum.length - 1] };
    });
    this.particles = [];
    this.routes.forEach((route, r) => {
      for (let i = 0; i < perRoute; i += 1) {
        this.particles.push({ route: r, offset: (i / perRoute) * route.length + hash(r * 97 + i) * 3, speed: speed * (0.82 + hash(r * 31 + i * 7) * 0.36) });
      }
    });
    this.layer = createPoints("DYNAMIC", Math.max(1, this.particles.length), shared, { hot: 0.9, renderOrder: 34 });
    const tint = new THREE.Color();
    this.particles.forEach((particle, i) => {
      tint.set(palette[(particle.route + i) % palette.length]);
      this.layer.aColor.set([tint.r, tint.g, tint.b], i * 3);
      this.layer.aSize[i] = size * (0.7 + hash(i * 13) * 0.6);
    });
  }

  update(motion: number, visibleFraction: number) {
    const { position, aParams } = this.layer;
    const limit = Math.floor(this.particles.length * visibleFraction);
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      const route = this.routes[particle.route];
      if (i >= limit || route.length <= 0) { aParams[i * 4] = 0; continue; }
      const s = (particle.offset + motion * particle.speed) % route.length;
      samplePolyline(route.xyz, route.cum, s, this.scratch);
      position[i * 3] = this.scratch.x;
      position[i * 3 + 1] = this.scratch.y;
      position[i * 3 + 2] = this.scratch.z;
      aParams[i * 4] = clamp01(s / 5) * clamp01((route.length - s) / 5);
    }
    this.layer.geometry.attributes.position.needsUpdate = true;
    this.layer.geometry.attributes.aParams.needsUpdate = true;
  }
}

function samplePolyline(xyz: Float32Array, cum: Float32Array, s: number, out: THREE.Vector3) {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const midIndex = (lo + hi) >> 1;
    if (cum[midIndex] <= s) lo = midIndex;
    else hi = midIndex;
  }
  const span = Math.max(1e-6, cum[hi] - cum[lo]);
  const w = (s - cum[lo]) / span;
  out.set(
    xyz[lo * 3] + (xyz[hi * 3] - xyz[lo * 3]) * w,
    xyz[lo * 3 + 1] + (xyz[hi * 3 + 1] - xyz[lo * 3 + 1]) * w,
    xyz[lo * 3 + 2] + (xyz[hi * 3 + 2] - xyz[lo * 3 + 2]) * w,
  );
  return out;
}

function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function routesAsLines(routes: IntroRoute[], drawStart: number, drawDuration: number, stagger: number, palette: string[]): Polyline[] {
  return routes.map((route, i) => ({ points: route.points, drawStart: drawStart + i * stagger, drawDuration, color: palette[i % palette.length], phase: i * 37 }));
}

// ---------------------------------------------------------------------------
// Environment grade (night → golden hero light → daylight hand-off)
// ---------------------------------------------------------------------------
interface LightState { light: THREE.Light; intensity: number; color: THREE.Color; ground?: THREE.Color }

class EnvironmentGrade {
  private lights: LightState[] = [];
  private sun: LightState | null = null;
  private fill: LightState | null = null;
  private ambient: LightState | null = null;
  private hemi: LightState | null = null;
  private fogState: { color: THREE.Color; near: number; far: number } | null = null;
  private ground: { material: THREE.MeshStandardMaterial; color: THREE.Color } | null = null;
  private exposure = 1;
  private readonly tmp = new THREE.Color();
  private readonly nightFog = color("#12123f");

  constructor(private readonly scene: THREE.Scene, private readonly gl: THREE.WebGLRenderer) {
    this.exposure = gl.toneMappingExposure;
    const fog = scene.fog as THREE.Fog | null;
    if (fog && "near" in fog) this.fogState = { color: fog.color.clone(), near: fog.near, far: fog.far };
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh && object.name === "DAYLIGHT_GROUND" && object.material instanceof THREE.MeshStandardMaterial) {
        this.ground = { material: object.material, color: object.material.color.clone() };
      }
      if (!(object instanceof THREE.Light) || object.userData.cinematicIntro) return;
      const state: LightState = { light: object, intensity: object.intensity, color: object.color.clone() };
      if (object instanceof THREE.HemisphereLight) { state.ground = object.groundColor.clone(); this.hemi = state; }
      else if (object instanceof THREE.AmbientLight) this.ambient = state;
      else if (object instanceof THREE.DirectionalLight) {
        if (!this.sun || object.intensity > this.sun.intensity) { if (this.sun) this.fill = this.sun; this.sun = state; }
        else this.fill = state;
      }
      this.lights.push(state);
    });
  }

  /** Night grade until the hero beat, golden key light on the hero frame, dawn on hand-off. */
  apply(t: number) {
    const dawn = ramp(t, 9.85, 11.55);
    const night = 1 - dawn;
    const gold = envelope(t, 8.25, 9.0, 9.9, 11.2);
    const lerpLight = (state: LightState | null, intensity: number, hex: string) => {
      if (!state) return;
      state.light.intensity = THREE.MathUtils.lerp(state.intensity, intensity, night);
      state.light.color.copy(state.color).lerp(this.tmp.set(hex), night);
    };
    lerpLight(this.ambient, 0.14, "#1b2a78");
    lerpLight(this.hemi, 0.62, "#4446c4");
    if (this.hemi?.ground) (this.hemi.light as THREE.HemisphereLight).groundColor.copy(this.hemi.ground).lerp(this.tmp.set("#081638"), night);
    // Key: violet at night, warm gold on the hero frame.
    if (this.sun) {
      const nightIntensity = THREE.MathUtils.lerp(1.05, 1.55, gold);
      this.sun.light.intensity = THREE.MathUtils.lerp(this.sun.intensity, nightIntensity, night);
      const nightColor = this.tmp.set("#9a63ff").lerp(new THREE.Color("#ffb44a"), gold);
      this.sun.light.color.copy(this.sun.color).lerp(nightColor, night);
    }
    lerpLight(this.fill, 1.25, "#2bd2ff");
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog && this.fogState) {
      fog.color.copy(this.fogState.color).lerp(this.nightFog, night);
      fog.near = THREE.MathUtils.lerp(this.fogState.near, 110, night);
      fog.far = THREE.MathUtils.lerp(this.fogState.far, 620, night);
    }
    this.gl.toneMappingExposure = THREE.MathUtils.lerp(this.exposure, 1.0 + gold * 0.05, night);
    // The open plain around the campus reads as midnight, so the lit campus stays the subject.
    if (this.ground) this.ground.material.color.copy(this.ground.color).lerp(this.tmp.set("#0c1236"), night);
  }

  restore() {
    for (const state of this.lights) {
      state.light.intensity = state.intensity;
      state.light.color.copy(state.color);
      if (state.ground) (state.light as THREE.HemisphereLight).groundColor.copy(state.ground);
    }
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog && this.fogState) {
      fog.color.copy(this.fogState.color);
      fog.near = this.fogState.near;
      fog.far = this.fogState.far;
    }
    this.gl.toneMappingExposure = this.exposure;
    if (this.ground) this.ground.material.color.copy(this.ground.color);
  }
}

// ---------------------------------------------------------------------------
// The layer stack
// ---------------------------------------------------------------------------
export interface IntroFrame {
  t: number;
  motion: number;
  camera: THREE.PerspectiveCamera;
  drawingBuffer: THREE.Vector2;
  pixelRatio: number;
  level: IntroEffectLevel;
}

export class IntroLayers {
  /** Model-local content (placed under the calibration transform). */
  readonly local = new THREE.Group();
  /** World-space content (sky dome follows the camera). */
  readonly world = new THREE.Group();
  private readonly shared: Shared;
  private readonly glows: Array<{ material: GlowMaterial; baseWidth: number; envelope: (t: number) => number }> = [];
  private readonly rings: Array<ReturnType<typeof createRing>> = [];
  private readonly grade: EnvironmentGrade;
  private readonly flows: RouteFlow[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly grid: ReturnType<typeof createGroundPlane>;
  private readonly scan: ReturnType<typeof createGroundPlane>;
  private readonly dome: THREE.Mesh<THREE.SphereGeometry, PlaneMaterial>;
  private readonly sparkFlare: ReturnType<typeof createBillboard>;
  private readonly sparkStreak: ReturnType<typeof createBillboard>;
  private readonly heroFlare: ReturnType<typeof createBillboard>;
  private readonly beam: ReturnType<typeof createBillboard>;
  private readonly nodes: ReturnType<typeof createPoints>;
  private readonly sparks: ReturnType<typeof createPoints>;
  private readonly dust: ReturnType<typeof createPoints> | null;
  private readonly primaryFlow: RouteFlow;
  private readonly altFlow: RouteFlow;
  private readonly assemblyFlow: RouteFlow;
  private warmFrames = 0;
  private readonly scanWorld = new THREE.Vector3();
  private readonly parentQuaternion = new THREE.Quaternion();

  constructor(data: IntroData, scene: THREE.Scene, gl: THREE.WebGLRenderer, level: IntroEffectLevel) {
    this.shared = {
      uTime: { value: 0 },
      uMotion: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uSizeScale: { value: 600 },
      uMaxSize: { value: 64 },
      uScanY: { value: -10 },
    };
    this.local.name = "CINEMATIC_INTRO_LOCAL";
    this.world.name = "CINEMATIC_INTRO_WORLD";
    this.grade = new EnvironmentGrade(scene, gl);

    // Sky dome --------------------------------------------------------------
    const domeMaterial = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: {
        uOpacity: { value: 1 },
        uMotion: this.shared.uMotion,
        uZenith: { value: color("#02040f") },
        uMid: { value: color("#080f33") },
        uHorizon: { value: color("#12123f") },
        uGlow: { value: color("#4a2fc8") },
        uGround: { value: color("#12123f") },
        uGlowDir: { value: new THREE.Vector2(0.55, -0.83).normalize() },
      },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
    }) as PlaneMaterial;
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(3600, 48, 24), domeMaterial);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -100;
    this.world.add(this.dome);

    // Ground grid + scan slice ---------------------------------------------
    this.grid = createGroundPlane(640, GRID_FRAG, {
      uReveal: { value: 0 },
      uCenter: { value: new THREE.Vector2(INTRO_SPARK_POINT[0], INTRO_SPARK_POINT[2]) },
      uOpacity: { value: 0 },
      uNear: { value: color("#2a9dff") },
      uFar: { value: color("#6a3cff") },
      uFront: { value: color("#ff4fd0") },
    }, { renderOrder: 9 });
    this.grid.mesh.position.y = 0.13;
    this.local.add(this.grid.mesh);

    const rects = [
      new THREE.Vector4(-52.3, -3.7, -10, 3.7),
      new THREE.Vector4(-3.6, 10.1, 3.7, 52.3),
      new THREE.Vector4(-3.65, 9.88, -9.88, 3.65),
      new THREE.Vector4(-60.45, -51.95, -10.75, 4.25),
      new THREE.Vector4(-4.25, 10.75, 51.95, 60.45),
    ];
    this.scan = createGroundPlane(150, SCAN_FRAG, {
      uRects: { value: rects },
      uAlpha: { value: 0 },
      uColor: { value: color("#2fb8ff") },
      uEdge: { value: color("#9ff3ff") },
    }, { depthTest: false, renderOrder: 14 });
    this.local.add(this.scan.mesh);

    // Glow line layers --------------------------------------------------------
    const addGlow = (lines: Polyline[], options: GlowOptions, env: (t: number) => number) => {
      if (!lines.length) return;
      const layer = createGlowLines(lines, this.shared, options);
      this.local.add(layer.mesh);
      this.glows.push({ material: layer.material, baseWidth: layer.baseWidth, envelope: env });
      this.disposables.push(layer.mesh.geometry, layer.material);
    };
    addGlow(data.sparkRays, { width: 5, trail: { speed: 46, length: 9, base: 0.45 }, hot: 0.9 }, (t) => envelope(t, 0.12, 0.3, 2.2, 3.0));
    addGlow(data.blueprint, { width: 1.7, depthTest: true, depthBias: 0.0006, hot: 0.7, scanBoost: 2.4, belowScan: 0.22 }, (t) => envelope(t, 0.25, 0.5, 4.5, 5.6));
    addGlow(data.fieldLines, { width: 1.9, depthTest: true, depthBias: 0.0004, hot: 0.5 }, (t) => envelope(t, 0.25, 0.5, 10.1, 11.2) * (1 - 0.55 * envelope(t, 4.6, 5.3, 7.7, 8.3)));
    addGlow(data.edgeRunners, { width: 2.6, depthTest: true, depthBias: 0.0009, trail: { speed: 34, length: 16, base: 0.12 }, hot: 0.8 }, (t) => envelope(t, 3.9, 4.5, 10.0, 11.0) * (1 - 0.6 * envelope(t, 5.0, 5.6, 7.7, 8.4)));
    addGlow(
      data.networkEdges.map((edge) => {
        const y = edge.points[0][1];
        return {
          points: edge.points,
          drawStart: 4.85 + (y / 31.5) * 0.55,
          drawDuration: 0.3,
          color: edge.kind === "stair" ? C.violet : edge.kind === "junction" ? C.cyan : edge.kind === "exit" ? C.mint : C.structure,
        };
      }),
      { width: 1.6, hot: 0.35 },
      (t) => envelope(t, 4.85, 5.2, 8.0, 8.9) * 0.62,
    );
    addGlow(routesAsLines(data.primaryRoutes, 5.15, 0.8, 0.06, ["#9ff6ff", "#62dcff", "#b9c8ff"]), { width: 3.4, trail: { speed: 24, length: 11, base: 0.3 }, hot: 0.85 }, (t) => envelope(t, 5.1, 5.5, 8.2, 9.1));
    addGlow(routesAsLines(data.alternativeRoutes, 6.95, 1.0, 0.12, [C.mint]), { width: 4.6, trail: { speed: 28, length: 12, base: 0.42 }, hot: 0.9 }, (t) => envelope(t, 6.9, 7.0, 9.6, 10.6));
    addGlow(
      data.assemblyFlows.map((points, i) => ({ points, drawStart: 8.0 + (i % 9) * 0.05, drawDuration: 0.7, color: i % 3 === 0 ? C.mint : C.gold, phase: i * 11 })),
      { width: 3.2, depthTest: true, depthBias: 0.0005, trail: { speed: 22, length: 9, base: 0.38 }, hot: 0.9 },
      (t) => envelope(t, 7.95, 8.4, 10.3, 11.3),
    );

    // Rings ---------------------------------------------------------------------
    const spark: Vec3 = [INTRO_SPARK_POINT[0], 0.16, INTRO_SPARK_POINT[2]];
    const field: Vec3 = [data.assemblyCenter[0], 0.42, data.assemblyCenter[2]];
    const b = data.bottleneck.position;
    const ringSpecs: RingSpec[] = [
      { center: spark, start: 0.1, duration: 1.7, maxRadius: 150, thickness: 2.4, colorA: "#ffffff", colorB: C.magenta, peak: 1.2 },
      { center: spark, start: 0.36, duration: 2.0, maxRadius: 230, thickness: 3.2, colorA: C.cyan, colorB: C.violet },
      { center: spark, start: 0.72, duration: 2.3, maxRadius: 300, thickness: 4.2, colorA: C.structureBright, colorB: C.violet, peak: 0.7 },
      { center: [b[0], b[1] + 0.25, b[2]], start: 6.0, duration: 1, period: 0.95, until: 8.5, minRadius: 1.2, maxRadius: 9, thickness: 0.5, colorA: "#ffb062", colorB: "#ff6a12", depthTest: false, peak: 0.85 },
      { center: [b[0], b[1] + 0.25, b[2]], start: 6.32, duration: 1, period: 0.95, until: 8.5, minRadius: 1.2, maxRadius: 9, thickness: 0.5, colorA: "#ffb062", colorB: "#ff6a12", depthTest: false, peak: 0.65 },
      { center: field, start: 8.85, duration: 1.15, minRadius: 6, maxRadius: 70, thickness: 1.5, colorA: "#ffe08a", colorB: C.gold, peak: 0.95 },
      { center: field, start: 8.98, duration: 1.35, minRadius: 10, maxRadius: 130, thickness: 2.2, colorA: C.cyan, colorB: C.magenta, peak: 0.45 },
    ];
    for (const spec of ringSpecs) {
      const ring = createRing(spec);
      this.rings.push(ring);
      this.local.add(ring.mesh);
      this.disposables.push(ring.mesh.geometry, ring.material);
    }

    // Flares + hero beam -----------------------------------------------------------
    this.sparkFlare = createBillboard(FLARE_FRAG, { uColor: { value: color("#7fd8ff") }, uIntensity: { value: 0 }, uStreak: { value: 0 }, uAspect: { value: 1 } }, 45, false);
    this.sparkStreak = createBillboard(FLARE_FRAG, { uColor: { value: color("#c06bff") }, uIntensity: { value: 0 }, uStreak: { value: 1 }, uAspect: { value: 7 } }, 46, false);
    this.heroFlare = createBillboard(FLARE_FRAG, { uColor: { value: color("#ffc35a") }, uIntensity: { value: 0 }, uStreak: { value: 0.8 }, uAspect: { value: 5 } }, 45, false);
    this.beam = createBillboard(BEAM_FRAG, { uColor: { value: color("#ffcf6a") }, uIntensity: { value: 0 } }, 44);
    this.sparkFlare.mesh.position.set(spark[0], 1.4, spark[2]);
    this.sparkStreak.mesh.position.set(spark[0], 1.4, spark[2]);
    this.heroFlare.mesh.position.set(field[0], 1.2, field[2]);
    this.beam.mesh.position.set(field[0], 0, field[2]);
    for (const item of [this.sparkFlare, this.sparkStreak, this.heroFlare, this.beam]) {
      this.local.add(item.mesh);
      this.disposables.push(item.mesh.geometry, item.material);
    }

    // Graph nodes --------------------------------------------------------------------
    this.nodes = createPoints("STATIC", data.networkNodes.length, this.shared, { hot: 0.7, renderOrder: 32 });
    const tint = new THREE.Color();
    data.networkNodes.forEach((node, i) => {
      this.nodes.position.set(node.position, i * 3);
      const style = {
        room: [C.structure, 0.55], door: [C.cyan, 0.32], corridor: [C.structureBright, 0.42], junction: [C.cyan, 1.0],
        stair: [C.violet, 0.95], exit: [C.mint, 1.5], gate: [C.mint, 1.2], assembly: [C.gold, 1.6],
      }[node.type] as [string, number];
      tint.set(style[0]);
      this.nodes.aColor.set([tint.r, tint.g, tint.b], i * 3);
      this.nodes.aSize[i] = style[1];
      this.nodes.aParams.set([4.9 + (node.position[1] / 31.5) * 0.55 + hash(i) * 0.15, hash(i * 3) * 6.28, 0.9, 0], i * 4);
    });
    this.local.add(this.nodes.points);
    this.disposables.push(this.nodes.geometry, this.nodes.material);

    // Route flows --------------------------------------------------------------------
    const perRoute = level === 2 ? 30 : level === 1 ? 20 : 12;
    this.primaryFlow = new RouteFlow(data.primaryRoutes, perRoute, ["#eaffff", "#8fe9ff", "#c7d2ff"], this.shared, 0.75, 7.5);
    this.altFlow = new RouteFlow(data.alternativeRoutes, perRoute, [C.mint, "#b8ffe4"], this.shared, 0.85, 8.5);
    this.assemblyFlow = new RouteFlow(data.assemblyFlows.map((points) => ({ points })), Math.max(4, Math.round(perRoute / 3)), [C.gold, "#fff0c0", C.mint], this.shared, 0.9, 6);
    for (const flow of [this.primaryFlow, this.altFlow, this.assemblyFlow]) {
      this.flows.push(flow);
      this.local.add(flow.layer.points);
      this.disposables.push(flow.layer.geometry, flow.layer.material);
    }

    // Reveal sparks: born where the scan plane meets the facade -------------------------
    const sparkCount = level === 2 ? 900 : level === 1 ? 520 : 240;
    this.sparks = createPoints("SPARKS", sparkCount, this.shared, { hot: 0.8, renderOrder: 36 });
    const footprints = [
      { x: [-52.3, -3.7], z: [-10, 3.7] }, { x: [-3.6, 10.1], z: [3.7, 52.3] },
      { x: [-60.45, -51.95], z: [-10.75, 4.25] }, { x: [-4.25, 10.75], z: [51.95, 60.45] },
    ];
    const palette = [C.cyan, C.violet, C.magenta, C.gold, C.mint, C.structureBright].map((hex) => color(hex));
    for (let i = 0; i < sparkCount; i += 1) {
      const birth = SCAN_START + 0.05 + hash(i * 1.7) * (SCAN_END - SCAN_START - 0.2);
      const y = Math.max(0.2, Math.min(TOP_FOR_SPARKS, scanHeightAt(birth)));
      const fp = footprints[Math.floor(hash(i * 5.3) * footprints.length)];
      const side = Math.floor(hash(i * 9.1) * 4);
      const u = hash(i * 2.9);
      const x = side < 2 ? THREE.MathUtils.lerp(fp.x[0], fp.x[1], u) : side === 2 ? fp.x[0] : fp.x[1];
      const z = side >= 2 ? THREE.MathUtils.lerp(fp.z[0], fp.z[1], u) : side === 0 ? fp.z[0] : fp.z[1];
      const nx = side === 2 ? -1 : side === 3 ? 1 : 0;
      const nz = side === 0 ? -1 : side === 1 ? 1 : 0;
      this.sparks.position.set([x, y, z], i * 3);
      const speed = 2 + hash(i * 4.4) * 5;
      this.sparks.aVelocity!.set([nx * speed + (hash(i * 6.1) - 0.5) * 3, 1 + hash(i * 7.7) * 3.5, nz * speed + (hash(i * 8.3) - 0.5) * 3], i * 3);
      const c = palette[i % palette.length];
      this.sparks.aColor.set([c.r, c.g, c.b], i * 3);
      this.sparks.aSize[i] = 0.25 + hash(i * 3.3) * 0.45;
      this.sparks.aParams.set([birth, 0.9 + hash(i * 2.2) * 1.3, 1.6, 0], i * 4);
    }
    this.local.add(this.sparks.points);
    this.disposables.push(this.sparks.geometry, this.sparks.material);

    // Foreground dust (depth cue: near motes become soft bokeh) --------------------------
    if (level >= 1) {
      const count = level === 2 ? 320 : 160;
      this.dust = createPoints("DUST", count, this.shared, { renderOrder: 50 });
      for (let i = 0; i < count; i += 1) {
        this.dust.position.set([-120 + hash(i * 1.3) * 160, 1 + hash(i * 2.1) * 55, -30 + hash(i * 3.7) * 210], i * 3);
        const c = palette[(i * 7) % palette.length];
        this.dust.aColor.set([c.r * 0.5, c.g * 0.5, c.b * 0.5], i * 3);
        this.dust.aSize[i] = 0.12 + hash(i * 4.9) * 0.3;
        this.dust.aParams.set([hash(i) * 6.28, hash(i * 2) * 6.28, hash(i * 3) * 6.28, 0], i * 4);
      }
      this.local.add(this.dust.points);
      this.disposables.push(this.dust.geometry, this.dust.material);
    } else {
      this.dust = null;
    }

    this.disposables.push(this.dome.geometry, domeMaterial, this.grid.mesh.geometry, this.grid.material, this.scan.mesh.geometry, this.scan.material);
  }

  /** True once every intro program has been compiled at least once. */
  get warmed() {
    return this.warmFrames >= 2;
  }

  noteRendered() {
    this.warmFrames += 1;
    if (this.warmFrames >= 2) this.rings.forEach((ring) => { ring.warmed.done = true; });
  }

  update(frame: IntroFrame) {
    const { t, motion, camera, drawingBuffer, pixelRatio, level } = frame;
    const shared = this.shared;
    shared.uTime.value = t;
    shared.uMotion.value = motion;
    shared.uResolution.value.copy(drawingBuffer);
    shared.uSizeScale.value = drawingBuffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    shared.uMaxSize.value = 72 * pixelRatio;
    const scanLocal = scanHeightAt(t);
    shared.uScanY.value = scanLocal > 1e4 ? 1e5 : this.local.localToWorld(this.scanWorld.set(0, scanLocal, 0)).y;

    this.grade.apply(t);
    this.dome.position.copy(camera.position);
    const domeMaterial = this.dome.material;
    domeMaterial.uniforms.uOpacity.value = 1 - ramp(t, 9.95, 11.6);
    this.dome.visible = (domeMaterial.uniforms.uOpacity.value as number) > 0.002 || !this.warmed;

    // Layer envelopes
    const widthScale = pixelRatio * (level === 0 ? 0.85 : 1);
    for (const glow of this.glows) {
      glow.material.uniforms.uOpacity.value = glow.envelope(t);
      glow.material.uniforms.uWidth.value = glow.baseWidth * widthScale;
    }
    const gridU = this.grid.material.uniforms;
    gridU.uReveal.value = easeOutCubic(clamp01((t - 0.12) / 2.2)) * 260;
    gridU.uOpacity.value = envelope(t, 0.1, 0.5, 7.5, 8.6) * (0.8 - 0.5 * ramp(t, 2.6, 4.4));
    const scanU = this.scan.material.uniforms;
    this.scan.mesh.position.y = Math.min(scanLocal, 60);
    scanU.uAlpha.value = envelope(t, SCAN_START, SCAN_START + 0.15, SCAN_END - 0.35, SCAN_END);
    this.scan.mesh.visible = (scanU.uAlpha.value as number) > 0.002 || !this.warmed;

    for (const ring of this.rings) ring.update(t, motion);

    // Spark flare: ignition at 0.05s, then decays as the blueprint takes over.
    const ignite = ramp(t, 0.0, 0.12) * (1 - ramp(t, 0.5, 2.3));
    const flicker = 0.92 + 0.08 * Math.sin(motion * 37);
    this.billboard(this.sparkFlare.mesh, camera, 26 + 30 * ramp(t, 0, 0.25) * (1 - ramp(t, 0.25, 1.6)), 26);
    this.sparkFlare.material.uniforms.uIntensity.value = ignite * flicker * 1.6;
    this.billboard(this.sparkStreak.mesh, camera, 110, 16);
    this.sparkStreak.material.uniforms.uIntensity.value = ignite * 0.7 * (1 - ramp(t, 0.15, 1.1));
    const heroPulse = envelope(t, 8.8, 8.95, 9.25, 10.4);
    this.billboard(this.heroFlare.mesh, camera, 80, 18);
    this.heroFlare.material.uniforms.uIntensity.value = heroPulse * 0.55;
    this.cylindricalBillboard(this.beam.mesh, camera, 4.5, 64);
    this.beam.material.uniforms.uIntensity.value = envelope(t, 8.75, 9.0, 9.6, 10.6) * 0.75;
    this.sparkFlare.mesh.visible = ignite > 0.001 || !this.warmed;
    this.sparkStreak.mesh.visible = this.sparkFlare.mesh.visible;
    this.heroFlare.mesh.visible = heroPulse > 0.001 || !this.warmed;
    this.beam.mesh.visible = (this.beam.material.uniforms.uIntensity.value as number) > 0.001 || !this.warmed;

    this.nodes.material.uniforms.uOpacity.value = envelope(t, 4.85, 5.2, 8.0, 8.9);
    this.sparks.material.uniforms.uOpacity.value = 1;
    this.sparks.geometry.setDrawRange(0, Math.floor(this.sparks.count * (level === 0 ? 0.45 : level === 1 ? 0.75 : 1)));
    if (this.dust) {
      this.dust.material.uniforms.uOpacity.value = envelope(t, 0.2, 1.4, 10.2, 11.5) * (level >= 1 ? 1 : 0);
      this.dust.points.visible = level >= 1 || !this.warmed;
    }

    const flowShare = level === 0 ? 0.55 : level === 1 ? 0.8 : 1;
    const primaryOpacity = envelope(t, 5.25, 5.75, 8.4, 9.3);
    this.primaryFlow.layer.material.uniforms.uOpacity.value = primaryOpacity;
    if (primaryOpacity > 0 || !this.warmed) this.primaryFlow.update(motion, flowShare);
    const altOpacity = envelope(t, 7.25, 7.7, 9.8, 10.7);
    this.altFlow.layer.material.uniforms.uOpacity.value = altOpacity;
    if (altOpacity > 0 || !this.warmed) this.altFlow.update(motion, flowShare);
    const assemblyOpacity = envelope(t, 8.3, 8.8, 10.4, 11.4);
    this.assemblyFlow.layer.material.uniforms.uOpacity.value = assemblyOpacity;
    if (assemblyOpacity > 0 || !this.warmed) this.assemblyFlow.update(motion, flowShare);
  }

  private readonly lookScratch = new THREE.Vector3();

  private billboard(mesh: THREE.Mesh, camera: THREE.Camera, width: number, height: number) {
    mesh.quaternion.copy(camera.quaternion);
    if (mesh.parent) {
      // Cancel the calibration rotation so the quad still faces the camera.
      mesh.quaternion.premultiply(mesh.parent.getWorldQuaternion(this.parentQuaternion).invert());
    }
    mesh.scale.set(width, height, 1);
  }

  private cylindricalBillboard(mesh: THREE.Mesh, camera: THREE.Camera, width: number, height: number) {
    const world = mesh.getWorldPosition(this.lookScratch);
    const angle = Math.atan2(camera.position.x - world.x, camera.position.z - world.z);
    mesh.rotation.set(0, angle, 0);
    mesh.scale.set(width, height, 1);
    mesh.position.y = height / 2 + 0.2;
  }

  restoreEnvironment() {
    this.grade.restore();
  }

  dispose() {
    this.grade.restore();
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.local.clear();
    this.world.clear();
  }
}

const TOP_FOR_SPARKS = 33;
