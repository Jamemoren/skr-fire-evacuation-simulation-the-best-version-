import { useMemo } from "react";
import type { MapPackage } from "../evac/protocol";

interface MiniMapProps {
  map: MapPackage;
  buildingId: string;
  floor: number;
  /** Route nodes to draw (only the part on this building/floor is shown). */
  routeNodeIds?: string[];
  currentNodeId?: string | null;
  targetNodeId?: string | null;
  muted?: boolean;
  label: string;
  /** Roleplay only: the character's position (simulation coordinates) and view heading. */
  player?: { x: number; z: number; headingDeg: number } | null;
  /** Passages the system knows are unsafe (fire/smoke/heat) or closed — drawn so the route reads against them. */
  hazards?: { blockedEdgeIds: string[]; closedEdgeIds: string[] } | null;
}

/**
 * Small fixed-orientation plan of one floor (as drawn in the building plan — the model has no
 * compass reference, so no "north" is claimed and no arrow assumes which way the user faces).
 * Position and next landmark use shape + text, not colour alone.
 */
export function MiniMap({ map, buildingId, floor, routeNodeIds = [], currentNodeId, targetNodeId, muted = false, label, player = null, hazards = null }: MiniMapProps) {
  const data = useMemo(() => {
    const nodes = map.nodes.filter((node) => node.buildingId === buildingId && node.floor === floor);
    if (!nodes.length) return null;
    const ids = new Set(nodes.map((node) => node.id));
    const byId = new Map(map.nodes.map((node) => [node.id, node]));
    const edges = map.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const xs = nodes.map((node) => node.x), zs = nodes.map((node) => node.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const width = Math.max(10, maxX - minX), depth = Math.max(10, maxZ - minZ);
    // Long buildings are drawn in their own proportions inside a 320 × 180 box.
    const scale = Math.min(300 / width, 160 / depth);
    const offsetX = (320 - width * scale) / 2, offsetZ = (180 - depth * scale) / 2;
    const project = (x: number, z: number) => [offsetX + (x - minX) * scale, offsetZ + (z - minZ) * scale] as const;
    const routeOnFloor: Array<readonly [number, number]> = [];
    for (const id of routeNodeIds) {
      const node = byId.get(id);
      if (node && node.buildingId === buildingId && node.floor === floor) routeOnFloor.push(project(node.x, node.z));
    }
    // Unsafe/closed passages on this floor (an edge counts if either end is on the drawn floor).
    const blockedIds = new Set(hazards?.blockedEdgeIds ?? []);
    const closedIds = new Set(hazards?.closedEdgeIds ?? []);
    const marked = map.edges.filter((edge) => (blockedIds.has(edge.id) || closedIds.has(edge.id)) && (ids.has(edge.from) || ids.has(edge.to)))
      .map((edge) => {
        const a = byId.get(edge.from), b = byId.get(edge.to);
        if (!a || !b) return null;
        const pa = project(a.x, a.z), pb = project(b.x, b.z);
        return { a: pa, b: pb, mid: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2] as const, kind: blockedIds.has(edge.id) ? "hazard" as const : "closed" as const };
      }).filter((item): item is NonNullable<typeof item> => item !== null);
    const current = currentNodeId ? byId.get(currentNodeId) : undefined;
    const target = targetNodeId ? byId.get(targetNodeId) : undefined;
    return {
      edges: edges.map((edge) => { const a = byId.get(edge.from)!, b = byId.get(edge.to)!; return [project(a.x, a.z), project(b.x, b.z)] as const; }),
      rooms: nodes.filter((node) => node.type === "room").map((node) => project(node.x, node.z)),
      stairs: nodes.filter((node) => node.type === "stair").map((node) => ({ point: project(node.x, node.z), name: node.name })),
      route: routeOnFloor,
      marked,
      current: current && current.buildingId === buildingId && current.floor === floor ? project(current.x, current.z) : null,
      target: target && target.buildingId === buildingId && target.floor === floor ? { point: project(target.x, target.z), name: target.name } : null,
      project,
    };
  }, [map, buildingId, floor, routeNodeIds, currentNodeId, targetNodeId, hazards]);
  const playerMark = data && player ? { point: data.project(player.x, player.z), heading: player.headingDeg } : null;

  if (!data) return <div className="m-map is-empty">ไม่มีแผนผังของชั้นนี้</div>;
  return (
    <figure className={`m-map${muted ? " is-muted" : ""}`}>
      <svg viewBox="0 0 320 180" role="img" aria-label={label}>
        <rect x="0" y="0" width="320" height="180" rx="10" className="m-map-bg" />
        {data.edges.map(([a, b], index) => <line key={index} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="m-map-edge" />)}
        {data.rooms.map((point, index) => <rect key={index} x={point[0] - 3} y={point[1] - 3} width="6" height="6" rx="1.5" className="m-map-room" />)}
        {data.stairs.map((stair, index) => (
          <g key={index} className="m-map-stair"><rect x={stair.point[0] - 5} y={stair.point[1] - 5} width="10" height="10" rx="2" /><path d={`M${stair.point[0] - 3} ${stair.point[1] + 2.5}h2v-2h2v-2h2`} /></g>
        ))}
        {data.marked.map((item, index) => (
          <g key={`m${index}`} className={`m-map-hazard is-${item.kind}`}>
            <line x1={item.a[0]} y1={item.a[1]} x2={item.b[0]} y2={item.b[1]} />
            <path d={`M${item.mid[0] - 4} ${item.mid[1] - 4}l8 8M${item.mid[0] + 4} ${item.mid[1] - 4}l-8 8`} />
          </g>
        ))}
        {data.route.length > 1 && <polyline points={data.route.map((point) => point.join(",")).join(" ")} className="m-map-route-halo" />}
        {data.route.length > 1 && <polyline points={data.route.map((point) => point.join(",")).join(" ")} className="m-map-route" />}
        {!muted && data.route.length > 1 && <polyline points={data.route.map((point) => point.join(",")).join(" ")} className="m-map-route-flow" />}
        {data.target && (
          <g className="m-map-target">
            <rect x={data.target.point[0] - 6} y={data.target.point[1] - 6} width="12" height="12" transform={`rotate(45 ${data.target.point[0]} ${data.target.point[1]})`} />
          </g>
        )}
        {playerMark && (
          // The plan draws +z downward, so heading 0° (towards −z) points up and 90° (towards +x) right.
          <g className="m-map-player" transform={`translate(${playerMark.point[0]} ${playerMark.point[1]}) rotate(${playerMark.heading})`}>
            <path d="M0 -13 L7 3 L0 -1 L-7 3 Z" className="m-map-player-heading" />
            <circle r="5" />
          </g>
        )}
        {data.current && !playerMark && (
          <g className="m-map-you">
            <circle cx={data.current[0]} cy={data.current[1]} r="9" className="m-map-you-halo" />
            <circle cx={data.current[0]} cy={data.current[1]} r="5" />
          </g>
        )}
      </svg>
      <figcaption>
        <span><i className="m-key m-key-you" aria-hidden="true" />{player ? "ตัวละคร + ทิศที่หัน" : "ตำแหน่งที่ยืนยันล่าสุด"}</span>
        <span><i className="m-key m-key-route" aria-hidden="true" />เส้นทางชั้นนี้</span>
        <span><i className="m-key m-key-target" aria-hidden="true" />จุดถัดไป</span>
        <span><i className="m-key m-key-stair" aria-hidden="true" />บันได</span>
        {data.marked.some((item) => item.kind === "hazard") && <span><i className="m-key m-key-hazard" aria-hidden="true" />ทางที่มีไฟ/ควัน — ห้ามผ่าน</span>}
        {data.marked.some((item) => item.kind === "closed") && <span><i className="m-key m-key-closed" aria-hidden="true" />ทางที่ปิด</span>}
      </figcaption>
    </figure>
  );
}
