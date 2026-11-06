/**
 * Turns a graph route into a few landmark-based Thai instructions. Deliberately no "turn left /
 * turn right": the phone does not know which way the person is facing, so every step names the
 * stair, door, exit or assembly point to head for (map-fixed, signage-based guidance).
 */
import type { SimEdge, SimNode } from "../simulation/types";
import type { Maneuver, ManeuverKind } from "./protocol";
import { BUILDING_NAMES, displayNodeName, stairBaseName } from "./mapRegistry";

export interface ManeuverContext {
  nodeMap: Map<string, SimNode>;
  edgeMap: Map<string, SimEdge>;
  buildingOf: Map<string, string>;
}

function stepKind(edge: SimEdge): ManeuverKind {
  if (edge.id === "campus-straight-bridge-level-4") return "bridge";
  if (edge.kind === "room") return "leave-room";
  if (edge.kind === "stair") return edge.floorTo < edge.floorFrom ? "stair-down" : edge.floorTo > edge.floorFrom ? "stair-up" : "walk";
  if (edge.kind === "exit") return "exit";
  if (edge.kind === "assembly") return "assembly";
  if (edge.kind === "outdoor") return "outdoor";
  return "walk";
}

/** Stair edges in this graph include the short access passages; group by the stair they serve. */
function stairKey(edge: SimEdge) {
  return edge.id.replace(/-\d+(-\d+)?$/, "").replace(/-down$/, "");
}

export function buildManeuvers(nodeIds: string[], edgeIds: string[], ctx: ManeuverContext): Maneuver[] {
  const steps: Array<{ kind: ManeuverKind; nodeIds: string[]; edgeIds: string[]; distance: number; key: string }> = [];
  edgeIds.forEach((edgeId, index) => {
    const edge = ctx.edgeMap.get(edgeId);
    if (!edge) return;
    const kind = stepKind(edge);
    const key = kind === "stair-down" || kind === "stair-up" ? stairKey(edge) : kind;
    const last = steps[steps.length - 1];
    // Walking along corridors merges until something with a landmark changes (stair, exit, bridge…).
    if (last && last.kind === kind && last.key === key && kind !== "leave-room" && kind !== "bridge") {
      last.edgeIds.push(edgeId);
      last.nodeIds.push(nodeIds[index + 1]);
      last.distance += edge.distance;
      return;
    }
    steps.push({ kind, key, nodeIds: [nodeIds[index], nodeIds[index + 1]], edgeIds: [edgeId], distance: edge.distance });
  });
  // Exit + outdoor + assembly read better as one "leave the building, then go to …" sequence; keep
  // them separate but make each text name its landmark.
  return steps.map((step, index) => {
    const first = ctx.nodeMap.get(step.nodeIds[0]);
    const last = ctx.nodeMap.get(step.nodeIds[step.nodeIds.length - 1]);
    const buildingId = ctx.buildingOf.get(step.nodeIds[0]) ?? "site";
    const nextStep = steps[index + 1];
    const nextLandmarkNode = nextStep ? ctx.nodeMap.get(nextStep.nodeIds[0]) : last;
    let text = "";
    let landmark = displayNodeName(last);
    switch (step.kind) {
      case "leave-room":
        text = `ออกจาก${displayNodeName(first)} ทางประตูห้อง`;
        landmark = displayNodeName(last);
        break;
      case "walk": {
        const target = nextStep && (nextStep.kind === "stair-down" || nextStep.kind === "stair-up")
          ? stairBaseName(nextLandmarkNode)
          : nextStep?.kind === "bridge" ? "ทางเชื่อมชั้น 4" : nextStep?.kind === "exit" ? displayNodeName(nextLandmarkNode) : displayNodeName(last);
        text = `เดินไปทาง${target}`;
        landmark = target;
        break;
      }
      case "stair-down":
      case "stair-up":
        landmark = stairBaseName(last ?? first);
        text = `${step.kind === "stair-down" ? "ลง" : "ขึ้น"}${landmark} ไปชั้น ${last?.floor ?? "-"}`;
        break;
      case "bridge":
        landmark = "ทางเชื่อมชั้น 4";
        text = `ข้ามทางเชื่อมชั้น 4 ไป${BUILDING_NAMES[ctx.buildingOf.get(step.nodeIds[step.nodeIds.length - 1]) ?? ""] ?? "อีกอาคาร"}`;
        break;
      case "exit": {
        // Name the doorway people will see ("ทางออกกลาง", "ช่องทางออกตึก 3 บันได 1"), not the outside point.
        const doorway = step.nodeIds.map((id) => ctx.nodeMap.get(id)).find((node) => node && /ทางออก/.test(node.name));
        landmark = displayNodeName(doorway ?? last);
        text = `ออกจากอาคารที่${landmark}`;
        break;
      }
      case "outdoor": {
        const target = nextStep?.kind === "assembly" ? displayNodeName(ctx.nodeMap.get(nextStep.nodeIds[nextStep.nodeIds.length - 1])) : displayNodeName(last);
        text = `เดินไปทาง${target}`;
        landmark = target;
        break;
      }
      case "assembly":
        text = `เข้าจุด${displayNodeName(last).replace(/^จุด/, "")} แล้วรายงานตัวกับครู`;
        break;
      default:
        text = `ไปที่${displayNodeName(last)}`;
    }
    return {
      index,
      kind: step.kind,
      text,
      landmark,
      buildingId,
      floor: first?.floor ?? 0,
      nodeIds: step.nodeIds,
      edgeIds: step.edgeIds,
      distanceM: Math.round(step.distance),
    };
  });
}
