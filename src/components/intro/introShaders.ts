// GLSL for the cinematic opening. Every material is additive (or a single translucent
// sky dome) so glow reads like selective bloom without a full-screen post-process pass.

export const GLOW_LINE_VERT = /* glsl */ `
uniform vec2 uResolution;
uniform float uWidth;
uniform float uDepthBias;
attribute vec3 aA;
attribute vec3 aB;
attribute vec2 aCorner;
attribute vec4 aTiming;
attribute vec2 aPath;
attribute vec3 aColor;
varying float vSide;
varying float vT;
varying float vDist;
varying vec4 vTiming;
varying vec2 vPath;
varying vec3 vColor;
varying float vY;
void main() {
  vSide = aCorner.x;
  vT = aCorner.y;
  vTiming = aTiming;
  vPath = aPath;
  vColor = aColor;
  vDist = mix(aTiming.z, aTiming.w, aCorner.y);
  vY = (modelMatrix * vec4(mix(aA, aB, aCorner.y), 1.0)).y;
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(aA, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);
  if (ca.w < 0.2 || cb.w < 0.2) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 hres = uResolution * 0.5;
  vec2 sa = ca.xy / ca.w * hres;
  vec2 sb = cb.xy / cb.w * hres;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  vec4 c = aCorner.y < 0.5 ? ca : cb;
  float hw = uWidth * 0.5;
  vec2 off = n * aCorner.x * hw + dir * (aCorner.y * 2.0 - 1.0) * hw * 0.6;
  c.xy += off / hres * c.w;
  c.z -= uDepthBias * c.w;
  gl_Position = c;
}`;

export const GLOW_LINE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uMotion;
uniform float uOpacity;
uniform float uTrail;
uniform float uTrailSpeed;
uniform float uTrailLen;
uniform float uBase;
uniform float uHot;
uniform float uScanY;
uniform float uScanBoost;
uniform float uBelowScan;
varying float vSide;
varying float vT;
varying float vDist;
varying vec4 vTiming;
varying vec2 vPath;
varying vec3 vColor;
varying float vY;
void main() {
  float local = clamp((uTime - vTiming.x) / max(vTiming.y, 0.001), 0.0, 1.0);
  if (vT > local + 0.0005) discard;
  float s = abs(vSide);
  float core = exp(-s * s * 16.0);
  float halo = exp(-s * s * 3.2) * 0.45;
  float tip = step(local, 0.999) * exp(-max(0.0, local - vT) * 22.0);
  float trail = 0.0;
  if (uTrail > 0.0) {
    float cycle = vPath.x + uTrailLen * 4.0;
    float head = mod(uMotion * uTrailSpeed + vPath.y, cycle);
    float dd = head - vDist;
    trail = dd >= 0.0 ? exp(-dd / uTrailLen) : 0.0;
  }
  float scanBand = uScanBoost * exp(-pow((vY - uScanY) / 1.1, 2.0));
  float below = vY < uScanY ? uBelowScan : 1.0;
  float energy = mix(1.0, uBase + trail * 2.2, uTrail) * below + tip * 1.6 + scanBand;
  vec3 col = vColor * (core * 1.25 + halo) * energy + vec3(1.0) * core * uHot * (tip + trail * 0.55 + scanBand * 0.4);
  gl_FragColor = vec4(col * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;

export const POINTS_VERT = /* glsl */ `
uniform float uSizeScale;
uniform float uMaxSize;
uniform float uTime;
uniform float uMotion;
uniform float uOpacity;
attribute vec3 aColor;
attribute float aSize;
attribute vec4 aParams;
#ifdef SPARKS
attribute vec3 aVelocity;
#endif
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec3 p = position;
  float alpha = 1.0;
#ifdef STATIC
  alpha = smoothstep(aParams.x, aParams.x + 0.35, uTime) * aParams.z * (0.72 + 0.28 * sin(uMotion * 3.1 + aParams.y));
#endif
#ifdef SPARKS
  float age = uTime - aParams.x;
  alpha = (age > 0.0 && age < aParams.y) ? pow(1.0 - age / aParams.y, 1.5) * smoothstep(0.0, 0.06, age) : 0.0;
  float a = max(age, 0.0);
  p += aVelocity * (1.0 - exp(-a * aParams.z)) / aParams.z + vec3(0.0, 0.9 * a, 0.0);
#endif
#ifdef DUST
  p += vec3(sin(uMotion * 0.23 + aParams.x), sin(uMotion * 0.17 + aParams.y) * 0.6, cos(uMotion * 0.19 + aParams.z)) * 1.8;
  alpha = 0.55 + 0.45 * sin(uMotion * 0.8 + aParams.x * 3.0);
#endif
#ifdef DYNAMIC
  alpha = aParams.x;
#endif
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vColor = aColor;
  vAlpha = alpha * uOpacity;
  float size = aSize * uSizeScale / max(0.5, -mv.z);
  gl_PointSize = vAlpha < 0.003 ? 0.0 : min(size, uMaxSize);
}`;

export const POINTS_FRAG = /* glsl */ `
uniform float uHot;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
#ifdef DUST
  float r = sqrt(r2);
  float disc = smoothstep(1.0, 0.72, r) * 0.55 + exp(-r2 * 6.0) * 0.25;
  vec3 col = vColor * disc;
#else
  float core = exp(-r2 * 9.0);
  float halo = exp(-r2 * 2.6) * 0.5 * (1.0 - r2);
  vec3 col = vColor * (core + halo) + vec3(1.0) * core * core * core * uHot;
#endif
  gl_FragColor = vec4(col * vAlpha, 1.0);
  #include <colorspace_fragment>
}`;

export const PLANE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec2 vLocal;
void main() {
  vUv = uv;
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Expanding/pulsing ring on the ground. Plane geometry is in metres (local xy). */
export const RING_FRAG = /* glsl */ `
uniform float uRadius;
uniform float uThickness;
uniform float uAlpha;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float d = (r - uRadius) / uThickness;
  float ring = exp(-d * d);
  float wake = r < uRadius ? exp(-(uRadius - r) / max(1.0, uRadius * 0.22)) * 0.08 : 0.0;
  vec3 col = mix(uColorB, uColorA, exp(-d * d * 4.0)) * (ring * 1.25 + wake) + vec3(1.0) * pow(ring, 8.0) * 0.3;
  gl_FragColor = vec4(col * uAlpha, 1.0);
  #include <colorspace_fragment>
}`;

/** Ground blueprint grid that is revealed by the spark's shockwave. */
export const GRID_FRAG = /* glsl */ `
uniform float uReveal;
uniform vec2 uCenter;
uniform float uOpacity;
uniform vec3 uNear;
uniform vec3 uFar;
uniform vec3 uFront;
varying vec2 vLocal;
float gridLine(vec2 p, float spacing, float width) {
  vec2 g = abs(fract(p / spacing - 0.5) - 0.5) * spacing;
  vec2 fw = max(fwidth(p), vec2(0.0001));
  vec2 l = 1.0 - smoothstep(vec2(0.0), fw * width, g);
  return max(l.x, l.y);
}
void main() {
  vec2 p = vec2(vLocal.x, -vLocal.y);
  float d = length(p - uCenter);
  float minor = gridLine(p, 4.0, 1.0) * 0.16;
  float major = gridLine(p, 20.0, 1.3) * 0.75;
  float front = exp(-pow((d - uReveal) / 3.0, 2.0));
  float inside = smoothstep(uReveal + 2.0, uReveal - 14.0, d);
  float fade = exp(-d / 105.0);
  vec3 col = mix(uNear, uFar, smoothstep(15.0, 170.0, d));
  vec3 lines = col * (minor + major) * inside * fade;
  vec3 wave = uFront * front * (0.25 + major + minor * 0.6) * (0.35 + 0.65 * fade);
  gl_FragColor = vec4((lines + wave) * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;

/** Horizontal scan slice: bright exactly where it cuts the building footprint. */
export const SCAN_FRAG = /* glsl */ `
uniform vec4 uRects[5];
uniform float uAlpha;
uniform vec3 uColor;
uniform vec3 uEdge;
varying vec2 vLocal;
float boxMask(vec2 p, vec4 r, float soft) {
  vec2 lo = smoothstep(r.xz - soft, r.xz + soft, p);
  vec2 hi = 1.0 - smoothstep(r.yw - soft, r.yw + soft, p);
  return lo.x * hi.x * lo.y * hi.y;
}
float boxEdge(vec2 p, vec4 r, float w) {
  vec2 c = vec2((r.x + r.y) * 0.5, (r.z + r.w) * 0.5);
  vec2 h = vec2((r.y - r.x) * 0.5, (r.w - r.z) * 0.5);
  vec2 q = abs(p - c) - h;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  return exp(-sd * sd / (w * w));
}
void main() {
  vec2 p = vec2(vLocal.x, -vLocal.y);
  float inside = 0.0;
  float edge = 0.0;
  for (int i = 0; i < 5; i++) {
    inside = max(inside, boxMask(p, uRects[i], 0.35));
    edge = max(edge, boxEdge(p, uRects[i], 0.55));
  }
  vec2 g = abs(fract(p / 2.0 - 0.5) - 0.5) * 2.0;
  float grid = (1.0 - smoothstep(0.0, 0.12, min(g.x, g.y))) * 0.5;
  vec3 col = uColor * (inside * (0.22 + grid * 0.5)) + uEdge * edge * 1.6 + vec3(1.0) * pow(edge, 4.0) * 0.5;
  gl_FragColor = vec4(col * uAlpha, 1.0);
  #include <colorspace_fragment>
}`;

/** Billboard flare: round core, soft glow and an optional anamorphic streak. */
export const FLARE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uStreak;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= uAspect;
  float r = length(p);
  float core = exp(-r * r * 30.0);
  float glow = exp(-r * 3.8) * 0.65;
  float streak = exp(-abs(p.y) * 46.0) * exp(-abs(p.x) / max(0.001, uAspect) * 2.4) * uStreak;
  vec3 col = uColor * (glow + streak * 1.4) + vec3(1.0) * (core * 1.6 + streak * 0.35);
  gl_FragColor = vec4(col * uIntensity, 1.0);
  #include <colorspace_fragment>
}`;

/** Vertical light pillar (cylindrical billboard). */
export const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  float x = abs(vUv.x - 0.5) * 2.0;
  float core = exp(-x * x * 40.0);
  float glow = exp(-x * 3.0) * 0.5;
  float v = smoothstep(0.0, 0.08, vUv.y) * pow(1.0 - vUv.y, 1.6);
  vec3 col = (uColor * (glow + core) + vec3(1.0) * core * 0.6) * v;
  gl_FragColor = vec4(col * uIntensity, 1.0);
  #include <colorspace_fragment>
}`;

export const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Sky has no physical distance: prevent a far-plane hole through the dome.
  gl_Position.z = gl_Position.w * 0.999999;
}`;

/** Midnight sky with a violet horizon, cyan glow toward the campus and fine stars. */
export const DOME_FRAG = /* glsl */ `
uniform float uOpacity;
uniform float uMotion;
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uGround;
uniform vec2 uGlowDir;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.2, h));
  col = mix(col, uZenith, smoothstep(0.2, 0.8, h));
  col = mix(col, uGround, smoothstep(0.0, -0.25, h));
  float toward = max(dot(normalize(d.xz + 1e-5), uGlowDir), 0.0);
  col += uGlow * pow(toward, 3.0) * exp(-abs(h) * 9.0) * 0.38;
  vec3 s = d * 110.0;
  vec3 cell = floor(s);
  float rnd = hash(cell);
  vec3 f = fract(s) - 0.5 - (vec3(hash(cell + 3.1), hash(cell + 7.7), hash(cell + 1.9)) - 0.5) * 0.6;
  float star = step(0.982, rnd) * smoothstep(0.11, 0.0, length(f)) * smoothstep(0.03, 0.3, h);
  star *= 0.55 + 0.45 * sin(uMotion * (1.5 + rnd * 3.0) + rnd * 40.0);
  col += vec3(0.75, 0.85, 1.0) * star * 0.9;
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}`;
