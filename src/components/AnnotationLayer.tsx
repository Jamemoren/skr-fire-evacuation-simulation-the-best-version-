import { Html } from "@react-three/drei";
import { useMemo } from "react";
import { ANNOTATION_COLORS, ANNOTATION_ICONS, ANNOTATION_LABELS } from "../constants";
import { useMapperStore } from "../store";
import { useBuilding1Store } from "../building1/building1Store";

export function AnnotationLayer() {
  const annotations = useMapperStore((state) => state.annotations);
  const selectedAnnotationId = useMapperStore((state) => state.selectedAnnotationId);
  const connectFromId = useMapperStore((state) => state.connectFromId);
  const showLabels = useMapperStore((state) => state.showLabels);
  const hiddenTypes = useMapperStore((state) => state.hiddenTypes);
  const handleAnnotationClick = useMapperStore((state) => state.handleAnnotationClick);
  // Single-floor / interior view: only that floor's markers (plus ones without a floor), so the
  // floor being edited is not buried under the markers of every other floor.
  const floorOnly = useBuilding1Store((state) => (state.viewMode === "single-floor" || state.viewMode === "interior" ? state.selectedFloor : null));

  const ordered = useMemo(
    () => [...annotations].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [annotations],
  );

  return (
    <group name="SEMANTIC_ANNOTATIONS" userData={{ semanticOverlay: true }}>
      {ordered.map((annotation) => {
        if (!annotation.visible || hiddenTypes.includes(annotation.type)) return null;
        if (floorOnly !== null && annotation.floor != null && annotation.floor !== floorOnly) return null;
        const color = ANNOTATION_COLORS[annotation.type];
        const selected = selectedAnnotationId === annotation.id;
        const connecting = connectFromId === annotation.id;
        return (
          <group
            key={annotation.id}
            name={`annotation:${annotation.id}`}
            position={annotation.position}
            rotation={annotation.rotation}
            userData={{ semanticOverlay: true, annotationId: annotation.id }}
            onClick={(event) => {
              event.stopPropagation();
              const state = useMapperStore.getState();
              if (!state.transformDragging && Date.now() - state.lastTransformAt >= 250) handleAnnotationClick(annotation.id);
            }}
          >
            {annotation.shape === "box" ? (
              <>
                <mesh scale={annotation.size}>
                  <boxGeometry args={[1, 1, 1]} />
                  <meshBasicMaterial
                    color={color}
                    wireframe={annotation.type !== "custom"}
                    transparent
                    opacity={selected || connecting ? 1 : annotation.locked ? 0.45 : 0.72}
                    depthTest={annotation.type === "custom"}
                  />
                </mesh>
                {selected && (
                  <mesh scale={annotation.size.map((value) => value + 0.08) as [number, number, number]}>
                    <boxGeometry args={[1, 1, 1]} />
                    <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.65} depthTest={false} />
                  </mesh>
                )}
              </>
            ) : (
              <>
                <mesh position={[0, 0.8, 0]} scale={selected || connecting ? 1.5 : 1}>
                  <sphereGeometry args={[0.42, 18, 14]} />
                  <meshBasicMaterial color={color} depthTest={false} />
                </mesh>
                <mesh position={[0, 0.35, 0]}>
                  <cylinderGeometry args={[0.06, 0.06, 0.7, 8]} />
                  <meshBasicMaterial color={color} depthTest={false} />
                </mesh>
                {selected && (
                  <mesh position={[0, 0.8, 0]}>
                    <torusGeometry args={[0.72, 0.04, 8, 28]} />
                    <meshBasicMaterial color="#ffffff" depthTest={false} />
                  </mesh>
                )}
              </>
            )}
            {showLabels && (
              <Html
                position={[0, annotation.shape === "box" ? annotation.size[1] / 2 + 0.65 : 1.5, 0]}
                center
                distanceFactor={14}
                zIndexRange={[50, 0]}
              >
                <button
                  className={`world-label${selected ? " is-selected" : ""}${annotation.locked ? " is-locked" : ""}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    const state = useMapperStore.getState();
              if (!state.transformDragging && Date.now() - state.lastTransformAt >= 250) handleAnnotationClick(annotation.id);
                  }}
                >
                  <b>{ANNOTATION_ICONS[annotation.type]}</b>
                  <strong>{annotation.name}</strong>
                  <span>{ANNOTATION_LABELS[annotation.type]}</span>
                  {annotation.peopleCount > 0 && <em>{annotation.peopleCount} คน</em>}
                </button>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}
