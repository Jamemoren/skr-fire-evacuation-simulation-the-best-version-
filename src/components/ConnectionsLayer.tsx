import { Line } from "@react-three/drei";
import { useMemo } from "react";
import { useMapperStore } from "../store";

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

  return (
    <group name="SEMANTIC_CONNECTIONS" userData={{ semanticOverlay: true }}>
      {connections.map((connection) => {
        const from = positions.get(connection.fromId);
        const to = positions.get(connection.toId);
        if (!from || !to) return null;
        const selected = connection.id === selectedConnectionId;
        return (
          <Line
            key={connection.id}
            points={[from, to]}
            color={connection.enabled ? (selected ? "#ffffff" : CONNECTION_COLORS[connection.type]) : "#64748b"}
            lineWidth={selected ? Math.max(3, connection.width + 1) : Math.max(1, Math.min(6, connection.width))}
            dashed={!connection.enabled || !connection.bidirectional}
            dashSize={0.7}
            gapSize={0.35}
            transparent
            opacity={connection.enabled ? 0.9 : 0.45}
            onClick={(event) => {
              event.stopPropagation();
              selectConnection(connection.id);
            }}
          />
        );
      })}
    </group>
  );
}
