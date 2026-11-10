/** Always-mounted, tiny: listens for “นำเสนอ” and loads the presentation code only when it is opened. */
import { lazy, Suspense, useEffect } from "react";
import { OPEN_PRESENTATION_EVENT } from "./presentEvents";
import { enterFullscreen, usePresentStore } from "./presentStore";

const PresentationMode = lazy(() => import("./PresentationMode").then((module) => ({ default: module.PresentationMode })));

export function PresentationHost() {
  const open = usePresentStore((state) => state.open);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const state = usePresentStore.getState();
      if (state.open) return;
      const detail = (event as CustomEvent<{ slide?: number } | undefined>).detail;
      void enterFullscreen();
      state.set({ open: true, mode: detail?.slide !== undefined ? "slides" : "start", suspended: false, tocOpen: false, index: Math.max(0, detail?.slide ?? 0), saved: null });
    };
    const onDemoEnded = (event: Event) => {
      const origin = (event as CustomEvent<{ origin?: string }>).detail?.origin;
      if (origin === "presentation" && usePresentStore.getState().open) usePresentStore.getState().set({ suspended: false });
    };
    window.addEventListener(OPEN_PRESENTATION_EVENT, onOpen);
    window.addEventListener("skr:auto-demo-ended", onDemoEnded);
    return () => { window.removeEventListener(OPEN_PRESENTATION_EVENT, onOpen); window.removeEventListener("skr:auto-demo-ended", onDemoEnded); };
  }, []);
  if (!open) return null;
  return <Suspense fallback={<div className="pz-loading" role="status">กำลังเปิดโหมดนำเสนอ…</div>}><PresentationMode /></Suspense>;
}
