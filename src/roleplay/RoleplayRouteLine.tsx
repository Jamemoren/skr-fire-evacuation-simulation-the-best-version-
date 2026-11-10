/**
 * The phone's advised route drawn in the 3D world while the roleplay runs: a bright line on the
 * walkway from where the character stands to the next ~45 m of the route, with arrows every 2.5 m
 * pointing the walking direction. It follows the same walkway polyline as the guidance arrow
 * (routePolyline), so it never cuts through a wall, and it updates when the phone gets a new route
 * (e.g. a fire blocks the old one). Nothing is drawn without a current route.
 */
import { useMemo } from "react";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { roleplaySession as session } from "./session";
import { useRoleplayStore } from "./roleplayStore";
import { closestOnPath, routePolyline } from "./playerMotion";
import type { Vec3 } from "../simulation/types";

const SHOW_AHEAD_M = 45;
const ARROW_EVERY_M = 2.5;
const LIFT = 0.07;

const arrowShape = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.32); shape.lineTo(0.24, -0.08); shape.lineTo(0.09, -0.08); shape.lineTo(0.09, -0.3);
  shape.lineTo(-0.09, -0.3); shape.lineTo(-0.09, -0.08); shape.lineTo(-0.24, -0.08); shape.closePath();
  return new THREE.ShapeGeometry(shape);
})();

export function RoleplayRouteLine() {
  const phase = useRoleplayStore((state) => state.phase);
  // The guide updates a few times a second; it carries the character's position.
  const position = useRoleplayStore((state) => state.guide?.position ?? null);
  const route = session.route;
  const routeKey = route ? `${route.routeId}:${route.revision}` : "";
  const navigatorWorld = session.navigator?.world ?? null;
  const built = useMemo(() => (route && navigatorWorld ? routePolyline(navigatorWorld, route.nodeIds, route.edgeIds) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeKey, navigatorWorld]);

  const ahead = useMemo(() => {
    if (!built || !position) return null;
    const { polyline } = built;
    const nearest = closestOnPath(position as Vec3, polyline);
    const points: Vec3[] = [nearest.point];
    let left = SHOW_AHEAD_M;
    for (let index = nearest.segment + 1; index < polyline.length && left > 0; index += 1) {
      const prev = points[points.length - 1], next = polyline[index];
      const length = Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
      if (length > left) {
        const t = left / Math.max(1e-6, length);
        points.push([prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t, prev[2] + (next[2] - prev[2]) * t]);
        break;
      }
      points.push(next);
      left -= length;
    }
    if (points.length < 2) return null;
    // Arrows along the line, each turned towards the walking direction (flat on the walkway).
    const arrows: Array<{ at: Vec3; yaw: number }> = [];
    let carry = ARROW_EVERY_M * 0.6;
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1], b = points[index];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      let along = carry;
      while (along < length) {
        const t = along / length;
        arrows.push({ at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], yaw: Math.atan2(b[0] - a[0], b[2] - a[2]) });
        along += ARROW_EVERY_M;
      }
      carry = along - length;
    }
    return { line: points.map((p) => [p[0], p[1] + LIFT, p[2]] as [number, number, number]), arrows };
  }, [built, position]);

  if (phase !== "playing" || !ahead) return null;
  return (
    <group name="ROLEPLAY_ROUTE_LINE">
      <Line points={ahead.line} color="#ffffff" lineWidth={9} transparent opacity={0.55} depthWrite={false} />
      <Line points={ahead.line} color="#1f8bff" lineWidth={5} transparent opacity={0.95} depthWrite={false} />
      {ahead.arrows.map((arrow, index) => (
        <mesh key={index} geometry={arrowShape} position={[arrow.at[0], arrow.at[1] + LIFT + 0.01, arrow.at[2]]} rotation={[-Math.PI / 2, 0, arrow.yaw + Math.PI]} renderOrder={5}>
          <meshBasicMaterial color="#ffffff" transparent opacity={0.92} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}
