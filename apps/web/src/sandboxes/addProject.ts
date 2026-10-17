import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";

import { waitForProject } from "../state/entities";
import { addSandboxProject, findSlotForRepo, useSandboxDirectoryStore } from "./directory";

const PROJECT_TIMEOUT_MS = 10_000;

/**
 * Adds a GitHub repository as a sandbox project and resolves once the app
 * lists it, with its unstarted sandbox's copy of the project to start a
 * draft in.
 */
export async function addSandboxProjectRef(repo: string): Promise<ScopedProjectRef> {
  await addSandboxProject(repo);
  const slot = findSlotForRepo(useSandboxDirectoryStore.getState().entries, repo);
  if (slot?.environmentId == null) throw new Error("The control plane has no sandbox for it yet.");
  const ref = scopeProjectRef(
    EnvironmentId.make(slot.environmentId),
    ProjectId.make(slot.projectId),
  );
  await waitForProject(ref, PROJECT_TIMEOUT_MS);
  return ref;
}
