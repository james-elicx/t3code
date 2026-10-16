import { createFileRoute, Navigate } from "@tanstack/react-router";

import { isSandboxMode, SANDBOX_ID_PATTERN } from "../sandboxes/directory";
import { SandboxLauncherPage } from "../sandboxes/SandboxLauncher";

export interface SandboxRouteSearch {
  /** Prefills the repository, e.g. from "New thread" on a sandbox project. */
  readonly repo?: string;
  /**
   * The sandbox to launch now, without waiting for the form. Creating a
   * sandbox is idempotent, so reloading resumes the same launch.
   */
  readonly launch?: string;
}

function SandboxRouteView() {
  const search = Route.useSearch();
  if (!isSandboxMode()) return <Navigate to="/" replace />;
  return (
    <SandboxLauncherPage
      {...(search.repo ? { initialRepo: search.repo } : {})}
      {...(search.launch ? { launchId: search.launch } : {})}
    />
  );
}

export const Route = createFileRoute("/_chat/sandbox")({
  validateSearch: (search: Record<string, unknown>): SandboxRouteSearch => ({
    ...(typeof search.repo === "string" ? { repo: search.repo } : {}),
    ...(typeof search.launch === "string" && SANDBOX_ID_PATTERN.test(search.launch)
      ? { launch: search.launch }
      : {}),
  }),
  component: SandboxRouteView,
});
