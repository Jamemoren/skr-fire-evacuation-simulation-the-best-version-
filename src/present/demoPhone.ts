/**
 * The presentation's phone scene: a drill that exists only inside this browser tab.
 * A separate in-page backend (the same IncidentService and API code as the server) is created for
 * the slide and disposed afterwards — opening the slide never creates or starts anything on the
 * real server, and works with no server at all.
 *
 *   before: a test participant in the floor-2 corridor of Building 1 gets a route (normally the
 *           centre stair);
 *   after:  staff close the centre stair (fire) → the same participant's route changes, with the
 *           reason shown on the phone.
 */
import { createLocalBackend, type LocalBackend } from "../evac-local/localBackend";
import type { MapPackage, ParticipantView } from "../evac/protocol";

export const DEMO_START_NODE = "sim-corr-pink-f2-b3";
export const DEMO_CLOSED_GROUP = "b1-stair-center";

export interface PhoneDemo {
  map: MapPackage;
  before: ParticipantView;
  after: ParticipantView;
  dispose(): void;
}

async function call<T>(backend: LocalBackend, path: string, token: string | null, body?: unknown): Promise<T> {
  const response = await backend.fetch(new URL(path, window.location.origin), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data;
}

export async function runPhoneDemo(): Promise<PhoneDemo> {
  const backend = createLocalBackend();
  try {
    const staff = (await call<{ token: string }>(backend, "/api/auth/local-staff", null)).token;
    const map = await call<MapPackage>(backend, "/api/map", null);
    const { incident } = await call<{ incident: { id: string } }>(backend, "/api/admin/incidents", staff, { mode: "drill", title: "การสาธิตในงานนำเสนอ" });
    await call(backend, `/api/admin/incidents/${incident.id}/evacuate`, staff, {});
    const { ticket } = await call<{ ticket: string }>(backend, `/api/admin/incidents/${incident.id}/preview-ticket`, staff, {});
    const joined = await call<{ token: string; participantId: string }>(backend, "/api/participant/join", null, { previewTicket: ticket, deviceKey: `present-${Date.now()}`, displayName: "ผู้ชมการสาธิต" });
    const placed = await call<{ view: ParticipantView }>(backend, `/api/admin/participants/${joined.participantId}/demo`, staff, { action: "place", nodeId: DEMO_START_NODE });
    await call(backend, `/api/admin/incidents/${incident.id}/closures`, staff, { groupId: DEMO_CLOSED_GROUP, closed: true, reason: "ไฟที่บันไดกลาง (การสาธิต)" });
    const after = await call<ParticipantView>(backend, "/api/participant/me", joined.token);
    return { map, before: placed.view, after, dispose: () => backend.dispose() };
  } catch (error) {
    backend.dispose();
    throw error;
  }
}

/** Shown (and labelled as such) only if the in-page demo cannot run in this browser. */
export const PHONE_DEMO_FALLBACK = {
  before: ["อยู่ที่ โถงปีกซ้าย ชั้น 2", "เดินไปทางบันไดกลาง", "ลงบันไดกลางถึงชั้น 1", "ออกทางออกกลาง → จุดรวมพล"],
  after: ["เปลี่ยนคำแนะนำแล้ว · เหตุผล: บันไดกลางถูกปิด (ไฟ)", "เดินไปทางบันไดซ้าย", "ลงบันไดซ้ายถึงชั้น 1", "ออกทางออกซ้าย → จุดรวมพล"],
};
