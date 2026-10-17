import { useMemo, type CSSProperties } from "react";
import { useMapperStore } from "../store";
import { validateSemanticMap } from "../utils/validation";

const severityIcon = {
  error: "✕",
  warning: "!",
  info: "i",
  success: "✓",
} as const;

export function ValidationPanel() {
  const annotations = useMapperStore((state) => state.annotations);
  const connections = useMapperStore((state) => state.connections);
  const selectAnnotation = useMapperStore((state) => state.selectAnnotation);
  const requestCameraFocus = useMapperStore((state) => state.requestCameraFocus);
  const result = useMemo(
    () => validateSemanticMap(annotations, connections),
    [annotations, connections],
  );

  return (
    <div className="validation-panel">
      <div className="score-card">
        <div className="score-ring" style={{ "--score": `${result.score * 3.6}deg` } as CSSProperties}>
          <strong>{result.score}</strong><span>/100</span>
        </div>
        <div>
          <h3>ความพร้อมของข้อมูล</h3>
          <p>{result.reachableClassrooms}/{result.totalClassrooms} ห้องมีเส้นทางถึงจุดรวมพล</p>
          <small>{result.totalPeople.toLocaleString("th-TH")} / 3,000 คน</small>
        </div>
      </div>
      <div className="validation-list">
        {result.issues.map((issue) => (
          <button
            key={issue.id}
            type="button"
            className={`validation-item severity-${issue.severity}`}
            onClick={() => {
              if (!issue.annotationId) return;
              const annotation = annotations.find((item) => item.id === issue.annotationId);
              if (!annotation) return;
              selectAnnotation(annotation.id);
              requestCameraFocus(annotation.position);
            }}
          >
            <span>{severityIcon[issue.severity]}</span>
            <div><strong>{issue.title}</strong><small>{issue.detail}</small></div>
          </button>
        ))}
      </div>
    </div>
  );
}
