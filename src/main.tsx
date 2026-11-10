import "./evac-local/installRouter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./styles.css";
import "./campus-ui.css";
import "./navigation/walk-controls.css";
import "./editor-ui.css";
import "./design/tokens.css";
import "./design/components.css";
import "./design/editor-theme.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("ไม่พบ #root");

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
