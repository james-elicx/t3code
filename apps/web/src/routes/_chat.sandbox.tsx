import { createFileRoute, Navigate } from "@tanstack/react-router";

import { isSandboxMode } from "../sandboxes/directory";
import { SandboxLauncherPage } from "../sandboxes/SandboxLauncher";

function SandboxRouteView() {
  if (!isSandboxMode()) return <Navigate to="/" replace />;
  return <SandboxLauncherPage />;
}

export const Route = createFileRoute("/_chat/sandbox")({
  component: SandboxRouteView,
});
