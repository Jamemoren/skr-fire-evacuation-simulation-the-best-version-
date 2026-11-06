/** Full presentation opening (seconds). Every 3D and DOM cue is driven from one clock. */
export const CINEMATIC_INTRO_DURATION_SECONDS = 12;
/** prefers-reduced-motion: a still establishing frame with fades only. */
export const CINEMATIC_REDUCED_DURATION_SECONDS = 3.6;
/** `?intro=preview` holds on the hero frame so it can serve as the opening slide. */
export const CINEMATIC_HERO_HOLD_SECONDS = 9.9;
/** The camera reaches the operational pose here and stays still until hand-off. */
export const CINEMATIC_CAMERA_SETTLE_SECONDS = 11.55;
/** Dashboard panels start their staggered entrance here. */
export const CINEMATIC_UI_REVEAL_SECONDS = 10.5;

export const CINEMATIC_BEATS = {
  spark: [0, 2],
  reveal: [2, 5],
  intelligence: [5, 8],
  hero: [8, 10],
  handoff: [10, 12],
} as const;
export type CinematicBeat = keyof typeof CINEMATIC_BEATS;

// This is also the simulator's operational establishing view. Keeping one
// authoritative end pose prevents a visible camera jump when the intro unmounts.
export const CINEMATIC_INTRO_END_POSITION = [-108, 88, 164] as const;
export const CINEMATIC_INTRO_END_TARGET = [-8, 10, 52] as const;
export const CINEMATIC_INTRO_END_FOV = 55;
export const CINEMATIC_INTRO_END_SPAN = 190;
