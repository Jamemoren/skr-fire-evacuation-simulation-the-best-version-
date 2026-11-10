import { useSyncExternalStore } from "react";
import { getBackendMode, subscribeBackendMode, type BackendMode } from "./backendRouter";

/** Where /api requests go right now: "server", "browser" (in-page backend) or "checking". */
export function useBackendMode(): BackendMode {
  return useSyncExternalStore(subscribeBackendMode, getBackendMode, getBackendMode);
}
