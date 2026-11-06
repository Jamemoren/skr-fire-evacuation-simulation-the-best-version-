/**
 * Staff connection of the main dashboard to the incident backend. Nothing here runs until the
 * "ระบบนำทางมือถือ" panel is opened, so the 3D simulator keeps working without a backend.
 * The backend — not this tab — is the source of truth: closing the tab stops nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StaffSnapshot, StreamMessage } from "../evac/protocol";

const TOKEN_KEY = "skr-evac-staff-token";

export type StaffStatus = "idle" | "connecting" | "online" | "offline" | "need-token" | "no-backend";

export class StaffApiError extends Error {
  constructor(message: string, public code?: string, public status?: number) { super(message); }
}

export async function staffApi<T>(token: string, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new StaffApiError((data as { message?: string }).message ?? `HTTP ${response.status}`, (data as { error?: string }).error, response.status);
  return data as T;
}

export function useStaffConnection(enabled: boolean) {
  const [status, setStatus] = useState<StaffStatus>("idle");
  const [token, setToken] = useState<string | null>(() => { try { return window.sessionStorage.getItem(TOKEN_KEY); } catch { return null; } });
  const [snapshot, setSnapshot] = useState<StaffSnapshot | null>(null);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);

  // Obtain a token: saved for this tab, or automatically when the dashboard runs on the server machine.
  useEffect(() => {
    if (!enabled || token) return;
    let cancelled = false;
    setStatus("connecting");
    void (async () => {
      try {
        const response = await fetch("/api/auth/local-staff", { cache: "no-store" });
        if (cancelled) return;
        if (response.status === 403) { setStatus("need-token"); return; }
        if (!response.ok) { setStatus("no-backend"); return; }
        const data = await response.json() as { token: string };
        try { window.sessionStorage.setItem(TOKEN_KEY, data.token); } catch { /* private mode */ }
        setToken(data.token);
      } catch { if (!cancelled) setStatus("no-backend"); }
    })();
    return () => { cancelled = true; };
  }, [enabled, token]);

  useEffect(() => {
    if (!enabled || !token) return undefined;
    let closed = false;
    const open = () => {
      if (closed) return;
      setStatus((current) => (current === "online" ? "online" : "connecting"));
      const source = new EventSource(`/api/stream?staff=${encodeURIComponent(token)}`);
      sourceRef.current = source;
      source.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as StreamMessage;
          if (message.type === "staff") {
            setSnapshot((previous) => (previous && message.snapshot.revision < previous.revision && message.snapshot.serverTime < previous.serverTime ? previous : message.snapshot));
            setLastMessageAt(Date.now());
            setStatus("online");
          }
        } catch { /* ignore */ }
      };
      source.onerror = () => {
        setStatus("offline");
        if (source.readyState === EventSource.CLOSED) {
          source.close();
          // A rejected token (server restarted with a new one) → ask again.
          void fetch("/api/auth/check", { method: "POST", headers: { authorization: `Bearer ${token}` } }).then((response) => {
            if (response.status === 401) {
              try { window.sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
              setToken(null);
            } else retryRef.current = window.setTimeout(open, 3000);
          }).catch(() => { setStatus("no-backend"); retryRef.current = window.setTimeout(open, 5000); });
        }
      };
    };
    open();
    return () => {
      closed = true;
      sourceRef.current?.close();
      sourceRef.current = null;
      if (retryRef.current) window.clearTimeout(retryRef.current);
    };
  }, [enabled, token]);

  const login = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    try { window.sessionStorage.setItem(TOKEN_KEY, trimmed); } catch { /* ignore */ }
    setToken(trimmed);
  }, []);

  const call = useCallback(async <T,>(path: string, body?: unknown, method?: string) => {
    if (!token) throw new StaffApiError("ต้องเข้าสู่ระบบเจ้าหน้าที่ก่อน");
    return await staffApi<T>(token, path, body, method);
  }, [token]);

  return { status, token, snapshot, lastMessageAt, login, call };
}
