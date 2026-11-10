import { useIntroAudioSettings } from "./introAudioSettings";
import { sound, useSoundStatus } from "./soundManager";
import { UiIcon } from "../components/UiIcon";

/**
 * The site's sound switch (remembered in this browser). When the browser is holding sound back
 * until a click, it says so and this click starts it.
 */
export function SoundToggle({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const enabled = useIntroAudioSettings((state) => state.enabled);
  const status = useSoundStatus((state) => state.status);
  const blocked = enabled && status === "blocked";
  const label = !enabled ? "เปิดเสียง" : blocked ? "แตะเพื่อเปิดเสียง" : "ปิดเสียง";
  const state = !enabled ? "เสียงปิดอยู่" : blocked ? "เบราว์เซอร์รอให้กดก่อนเล่นเสียง" : status === "unsupported" ? "เบราว์เซอร์นี้เล่นเสียงไม่ได้" : "เสียงเปิดอยู่";
  return (
    <button type="button" className={`sound-toggle${blocked ? " is-blocked" : ""}${enabled ? "" : " is-off"} ${className}`}
      aria-pressed={enabled && !blocked} aria-label={`${label} (${state})`} data-tip={state}
      onClick={() => sound.setEnabled(!enabled || blocked)}>
      <UiIcon name={enabled && !blocked ? "soundOn" : "soundOff"} size={18} />
      {!compact && <span>{enabled && !blocked ? "เสียงเปิด" : blocked ? "เปิดเสียง" : "เสียงปิด"}</span>}
    </button>
  );
}
