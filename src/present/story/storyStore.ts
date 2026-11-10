import { create } from "zustand";

/** The story's one clock: everything animated in the story reads `elapsed` of the current beat. */
export interface StoryClock {
  beat: number;
  /** ms into the current beat (advances only while playing) */
  elapsed: number;
  playing: boolean;
  finished: boolean;
  /** “ลองปรับจำนวนคนรอเอง”: the queue chosen by the viewer, or null */
  tryLoad: number | null;
  /** playback speed (1; automated checks may raise it via ?qa) */
  rate: number;
  set(patch: Partial<Omit<StoryClock, "set">>): void;
}

export const useStoryClock = create<StoryClock>((set) => ({
  beat: 0, elapsed: 0, playing: false, finished: false, tryLoad: null, rate: 1,
  set: (patch) => set(patch),
}));
