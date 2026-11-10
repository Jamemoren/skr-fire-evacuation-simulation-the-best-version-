/**
 * 3D annotations for the presentation and the automatic editor demo: route lines that draw
 * themselves in walking direction, node dots with names, highlight frames around what is being
 * edited, a "before" ghost and an arrow to the "after" position, fire and closed-exit markers.
 * Driven by a small store; empty (and drawing nothing) when no story is running.
 */
import { Html, Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import { create } from "zustand";
import type { Vec3 } from "../simulation/types";
import "./story-overlay.css";

export interface StoryLine { id: string; points: Vec3[]; color: string; width?: number; dashed?: boolean; label?: string; /** Where along the line (0–1) the label sits; default the end. */ labelAt?: number; revealMs?: number; startedAt?: number }
export interface StoryMarker { id: string; position: Vec3; kind: "node" | "fire" | "closed" | "person" | "ghost" | "new"; label?: string; color?: string; /** larger dot and text (values read on the model) */ big?: boolean; /** smaller dot (graph nodes) */ small?: boolean }
export interface StoryBox { id: string; center: Vec3; size: Vec3; color: string; label?: string }

interface StoryState {
  lines: StoryLine[]; markers: StoryMarker[]; boxes: StoryBox[];
  set(patch: Partial<Pick<StoryState, "lines" | "markers" | "boxes">>): void;
  clear(): void;
}
// A clock that can be frozen: when the narrated story pauses, lines stop drawing exactly where they are.
let frozenAt: number | null = null;
let pausedTotal = 0;
export const overlayNow = () => (frozenAt ?? performance.now()) - pausedTotal;
export function freezeOverlay(on: boolean) {
  if (on && frozenAt === null) frozenAt = performance.now();
  if (!on && frozenAt !== null) { pausedTotal += performance.now() - frozenAt; frozenAt = null; }
}
export const useStoryOverlay = create<StoryState>((set) => ({
  lines: [], markers: [], boxes: [],
  set: (patch) => set({
    ...patch,
    ...(patch.lines ? { lines: patch.lines.map((line) => ({ ...line, startedAt: line.startedAt ?? overlayNow() })) } : {}),
  }),
  clear: () => set({ lines: [], markers: [], boxes: [] }),
}));

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const lift = (p: Vec3, dy = 0.35): Vec3 => [p[0], p[1] + dy, p[2]];

function partial(points: Vec3[], fraction: number): Vec3[] {
  if (fraction >= 1 || points.length < 2) return points;
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1], p[2] - points[i][2]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let left = total * Math.max(0, fraction);
  const out: Vec3[] = [points[0]];
  for (let i = 0; i < lengths.length; i += 1) {
    if (left >= lengths[i]) { out.push(points[i + 1]); left -= lengths[i]; continue; }
    const t = lengths[i] ? left / lengths[i] : 0;
    out.push([points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t, points[i][2] + (points[i + 1][2] - points[i][2]) * t]);
    break;
  }
  return out.length >= 2 ? out : [points[0], points[0]];
}

function RevealLine({ line }: { line: StoryLine }) {
  const [fraction, setFraction] = useState(() => (reduced() || !line.revealMs ? 1 : 0));
  const done = useRef(fraction >= 1);
  useFrame(() => {
    if (done.current) return;
    const t = Math.min(1, (overlayNow() - (line.startedAt ?? 0)) / Math.max(1, line.revealMs ?? 1));
    setFraction(t);
    if (t >= 1) done.current = true;
  });
  const points = useMemo(() => partial(line.points.map((p) => lift(p)), fraction), [line.points, fraction]);
  const head = line.labelAt == null ? points[points.length - 1] : lift(line.points[Math.round(line.labelAt * (line.points.length - 1))]);
  return (
    <group>
      {/* Both lines in the same (transparent) pass, so render order puts the colour over the outline. */}
      <Line points={points} color="#0b1426" lineWidth={(line.width ?? 5) + 5} transparent opacity={0.7} depthTest={false} renderOrder={20} />
      <Line points={points} color={line.color} lineWidth={line.width ?? 5} dashed={line.dashed} dashSize={0.9} gapSize={0.6} transparent opacity={1} depthTest={false} renderOrder={21} />
      {line.label && fraction >= 1 && (
        <Html position={head} center zIndexRange={[30, 10]} style={{ pointerEvents: "none" }}>
          <span className="story-label" style={{ borderColor: line.color }}>{line.label}</span>
        </Html>
      )}
    </group>
  );
}

const MARKER_COLOR: Record<StoryMarker["kind"], string> = { node: "#40b8d5", fire: "#ff5a36", closed: "#d7263d", person: "#ffd166", ghost: "#9fb3c8", new: "#4fd6a0" };

function Marker({ marker }: { marker: StoryMarker }) {
  const color = marker.color ?? MARKER_COLOR[marker.kind];
  const size = marker.kind === "fire" ? 0.9 : marker.kind === "person" ? 0.55 : marker.small ? 0.26 : 0.38;
  return (
    <group position={lift(marker.position, marker.kind === "fire" ? 0.9 : 0.4)}>
      {marker.kind === "closed" ? (
        <>
          <mesh rotation={[0, Math.PI / 4, 0]} renderOrder={22}><boxGeometry args={[2.4, 0.28, 0.28]} /><meshBasicMaterial color={color} depthTest={false} /></mesh>
          <mesh rotation={[0, -Math.PI / 4, 0]} renderOrder={22}><boxGeometry args={[2.4, 0.28, 0.28]} /><meshBasicMaterial color={color} depthTest={false} /></mesh>
        </>
      ) : (
        <mesh renderOrder={22}>
          <sphereGeometry args={[size, 20, 14]} />
          <meshBasicMaterial color={color} transparent opacity={marker.kind === "ghost" ? 0.45 : 0.95} depthTest={false} />
        </mesh>
      )}
      {marker.label && (
        <Html position={[0, size + 0.7, 0]} center zIndexRange={[30, 10]} style={{ pointerEvents: "none" }}>
          <span className={`story-label is-${marker.kind}${marker.big ? " is-big" : ""}`} data-anchor={marker.id} style={marker.color ? { borderColor: marker.color } : undefined}>{marker.label}</span>
        </Html>
      )}
    </group>
  );
}

function Box({ box }: { box: StoryBox }) {
  return (
    <group position={box.center}>
      <mesh renderOrder={19}>
        <boxGeometry args={box.size} />
        <meshBasicMaterial color={box.color} wireframe depthTest={false} transparent opacity={0.95} />
      </mesh>
      <mesh renderOrder={18}>
        <boxGeometry args={box.size} />
        <meshBasicMaterial color={box.color} depthTest={false} transparent opacity={0.12} />
      </mesh>
      {box.label && (
        <Html position={[0, box.size[1] / 2 + 0.8, 0]} center zIndexRange={[30, 10]} style={{ pointerEvents: "none" }}>
          <span className="story-label is-box" style={{ borderColor: box.color }}>{box.label}</span>
        </Html>
      )}
    </group>
  );
}

/**
 * Keeps on-model labels readable when the camera brings two anchors close on screen (e.g. the
 * top-down summary view): each label that would overlap an earlier one is nudged downwards with the
 * CSS `translate` property, which leaves drei's own positioning transform untouched.
 */
function LabelDeclutter() {
  const dom = useThree((state) => state.gl.domElement);
  const last = useRef(0);
  useFrame(({ clock }) => {
    const now = clock.elapsedTime;
    if (now - last.current < 0.12) return;
    last.current = now;
    const root = dom.parentElement?.parentElement ?? dom.parentElement;
    if (!root) return;
    const labels = Array.from(root.querySelectorAll<HTMLElement>(".story-label"));
    if (labels.length < 2) return;
    const boxes = labels.map((el) => {
      const shift = Number(el.dataset.shift || 0);
      const r = el.getBoundingClientRect();
      return { el, left: r.left, right: r.right, top: r.top - shift, bottom: r.bottom - shift, shift: 0 };
    }).sort((a, b) => a.top - b.top || a.left - b.left);
    const placed: typeof boxes = [];
    for (const box of boxes) {
      for (let guard = 0; guard < 6; guard += 1) {
        const hit = placed.find((o) => box.left < o.right + 2 && box.right > o.left - 2 && box.top + box.shift < o.bottom + o.shift + 2 && box.bottom + box.shift > o.top + o.shift - 2);
        if (!hit) break;
        box.shift = hit.bottom + hit.shift + 3 - box.top;
      }
      placed.push(box);
    }
    for (const box of boxes) {
      const next = Math.round(box.shift);
      if (Number(box.el.dataset.shift || 0) === next) continue;
      box.el.dataset.shift = String(next);
      box.el.style.translate = next ? `0 ${next}px` : "";
    }
  });
  return null;
}

export function StoryOverlay3D() {
  const { lines, markers, boxes } = useStoryOverlay();
  if (!lines.length && !markers.length && !boxes.length) return null;
  return (
    <group name="STORY_OVERLAY" userData={{ semanticOverlay: true, noPhysics: true }}>
      {lines.map((line) => <RevealLine key={`${line.id}:${line.startedAt}`} line={line} />)}
      {markers.map((marker) => <Marker key={marker.id} marker={marker} />)}
      {boxes.map((box) => <Box key={box.id} box={box} />)}
      <LabelDeclutter />
    </group>
  );
}
