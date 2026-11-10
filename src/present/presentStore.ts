import { create } from "zustand";
import type { CameraPose } from "../camera/cameraDirector";
import type { BuildingViewMode } from "../building1/building1Store";

/** What the presentation changed, so leaving puts the user's screen back exactly. */
export interface PresentSaved {
  viewMode: BuildingViewMode;
  floor: number;
  explode: boolean;
  pose: CameraPose | null;
  focus: HTMLElement | null;
  scroll: number;
}

interface PresentState {
  open: boolean;
  /** start = the choice screen; story = the narrated math story; slides = the slide deck */
  mode: "start" | "story" | "slides";
  /** The editor demo is playing on top of a paused presentation. */
  suspended: boolean;
  index: number;
  autoplay: boolean;
  tocOpen: boolean;
  saved: PresentSaved | null;
  set(patch: Partial<Omit<PresentState, "set">>): void;
}

export const usePresentStore = create<PresentState>((set) => ({
  open: false, mode: "start", suspended: false, index: 0, autoplay: false, tocOpen: false, saved: null,
  set: (patch) => set(patch),
}));

// ---------------------------------------------------------------- fullscreen (with fallbacks)
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
let weEnteredFullscreen = false;
export const fullscreenElement = () => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;
/** Must run inside the click that opened the presentation (browsers require a user gesture). */
export function enterFullscreen(): Promise<boolean> {
  const el = document.documentElement as FsEl;
  if (fullscreenElement()) return Promise.resolve(true);
  try {
    const request = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (!request) return Promise.resolve(false);
    return Promise.resolve(request()).then(() => { weEnteredFullscreen = true; return true; }, () => false);
  } catch { return Promise.resolve(false); }
}
export function leaveFullscreen() {
  if (!weEnteredFullscreen || !fullscreenElement()) { weEnteredFullscreen = false; return; }
  weEnteredFullscreen = false;
  const doc = document as FsDoc;
  try { void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()); } catch { /* already left */ }
}
export const enteredFullscreenByUs = () => weEnteredFullscreen;
export function markFullscreenLeft() { weEnteredFullscreen = false; }
