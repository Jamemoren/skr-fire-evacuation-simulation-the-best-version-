import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../design/tokens.css";
import "./mobile.css";
import { MobileApp } from "./MobileApp";
import { createLiveSource, type MobileSource } from "./client";

const params = new URLSearchParams(window.location.search);
const embedded = params.get("embed") === "1" && window.parent !== window;
const joinCode = params.get("join");
const checkpoint = params.get("cp");

function Root() {
  const [source, setSource] = useState<MobileSource | null>(null);
  // A source owns network connections. Create it in the effect so StrictMode's
  // setup → cleanup → setup sequence gets a fresh source after disposal.
  useEffect(() => {
    const live = createLiveSource({
      kind: embedded ? "preview" : "device",
      joinCode,
      previewTicket: embedded ? params.get("ticket") : null,
      incidentId: embedded ? params.get("incident") : null,
      checkpoint: checkpoint ? checkpoint.toUpperCase() : null,
    });
    setSource(live);
    return () => live.dispose();
  }, []);
  return source ? <MobileApp source={source} joinCodeHint={joinCode ?? ""} /> : <p role="status">กำลังเชื่อมต่อระบบ…</p>;
}

// Offline shell + versioned map for reference, scoped to /mobile (never controls the 3D dashboard).
// Only on a real device in a secure context — the
// preview frame never installs a service worker for the dashboard's origin scope.
if (!embedded && window.isSecureContext && "serviceWorker" in navigator) {
  window.addEventListener("load", () => { void navigator.serviceWorker.register("/mobile-sw.js", { scope: "/mobile" }).catch(() => undefined); });
}
// Clean the one-time parameters from the address bar (the QR link should not be re-submitted on reload).
if (!embedded && (joinCode || checkpoint)) window.history.replaceState(null, "", "/mobile");

const root = document.getElementById("mobile-root");
if (!root) throw new Error("ไม่พบ #mobile-root");
createRoot(root).render(<StrictMode><Root /></StrictMode>);
