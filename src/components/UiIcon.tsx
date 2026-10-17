const paths = {
  walk: "M14 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 22l3-7m4 7-3-10 1-5m-5 5 2-4 3-1 3 5 4 1M12 14l-4-2",
  campus: "M3 21V7l9-4 9 4v14M8 21v-5h8v5M7 9h1m8 0h1M7 12h1m8 0h1M12 7v5M2 21h20",
  scene: "m12 3 9 5v8l-9 5-9-5V8l9-5Zm0 0v10m9-5-9 5-9-5m9 5v8",
  controls: "M4 7h16M4 17h16M8 4v6m8 4v6",
  metrics: "M4 20V10m8 10V4m8 16v-7",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  close: "m6 6 12 12M18 6 6 18",
  play: "m8 5 11 7-11 7V5Z",
  pause: "M8 5v14M16 5v14",
  field: "M3 5h18v14H3V5Zm9 0v14M3 9h4v6H3m18-6h-4v6h4m-9-6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  top: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
} as const;
export function UiIcon({ name }: { name: keyof typeof paths }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
