import { Line } from "@react-three/drei";
import { useMemo } from "react";
import { useMapperStore } from "../store";
import { useBuilding1Store } from "../building1/building1Store";

const CONNECTION_COLORS = {
  walkway: "#5eead4",
  doorway: "#f5c451",
  stair: "#fb923c",
  "outdoor-path": "#60a5fa",
  custom: "#e879f9",
} as const;

export function ConnectionsLayer() {
  const annotations = useMapperStore((state) => state.annotations);
  const connections = useMapperStore((state) => state.connections);
  const selectedConnectionId = useMapperStore((state) => state.selectedConnectionId);
  const selectConnection = useMapperStore((state) => state.selectConnection);
  const positions = useMemo(
    () => new Map(annotations.map((annotation) => [annotation.id, annotation.position])),
    [annotations],
  );
  const floors = useMemo(() => new Map(annotations.map((annotation) => [annotation.id, annotation.floor])), [annotations]);
  // Single-floor / interior view: only passages on that floor (matches AnnotationLayer).
  const floorOnly = useBuilding1Store((state) => (state.viewMode === "single-floor" || state.viewMode === "interior" ? state.selectedFloor : null));

  return (
    <group name="SEMANTIC_CONNECTIONS" userData={{ semanticOverlay: true }}>
      {connections.map((connection) => {
        const from = positions.get(connection.fromId);
        const to = positions.get(connection.toId);
        if (!from || !to) return null;
        if (floorOnly !== null && [floors.get(connection.fromId), floors.get(connection.toId)].some((floor) => floor != null && floor !== floorOnly)) return null;
        const selected = connection.id === selectedConnectionId;
        return (
          <Line
            key={connection.id}
            points={[from, ...(connection.waypoints ?? []), to]}
            color={connection.enabled ? (selected ? "#ffffff" : CONNECTION_COLORS[connection.type]) : "#64748b"}
            lineWidth={selected ? Math.max(3, connection.width + 1) : Math.max(1, Math.min(6, connection.width))}
            dashed={!connection.enabled || !connection.bidirectional}
            dashSize={0.7}
            gapSize={0.35}
            transparent
            opacity={connection.enabled ? 0.9 : 0.45}
            onClick={(event) => {
              event.stopPropagation();
              const state = useMapperStore.getState();
              if (!state.transformDragging && Date.now() - state.lastTransformAt >= 250) selectConnection(connection.id);
            }}
          />
        );
      })}
    </group>
  );
}
