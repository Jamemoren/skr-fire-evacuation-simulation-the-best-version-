// Side-effect import: must be the first import of the dashboard entry so every /api call is routed.
import { installBackendRouter } from "./backendRouter";

installBackendRouter();
