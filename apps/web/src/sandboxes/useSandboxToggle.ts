import type { ScopedProjectRef } from "@t3tools/contracts";
import { useMemo } from "react";

import type { DraftId } from "../composerDraftStore";
import { useEnvironmentThreadRefs, useProject } from "../state/entities";
import { isSandboxMode, useSandboxDirectoryStore } from "./directory";
import {
  resolveSandboxToggle,
  sandboxInstanceToStart,
  selectSandboxChoice,
  type SandboxToggle,
  useSandboxChoiceStore,
} from "./toggle";

const HIDDEN: SandboxToggle = { kind: "hidden" };

/** The sandbox toggle for a draft in the composer, and what its first send starts. */
export function useSandboxToggle(draftId: DraftId | null, projectRef: ScopedProjectRef | null) {
  const enabled = draftId !== null && projectRef !== null && isSandboxMode();
  const project = useProject(enabled ? projectRef : null);
  const environmentId = enabled ? projectRef.environmentId : null;
  // Only the repository string, so the directory's polls don't re-render the composer.
  const sandboxRepo = useSandboxDirectoryStore((state) =>
    environmentId === null
      ? null
      : (state.entries.find((entry) => entry.environmentId === environmentId)?.repo ?? null),
  );
  const sandboxHasThread =
    useEnvironmentThreadRefs(sandboxRepo === null ? null : environmentId).length > 0;
  const choice = useSandboxChoiceStore((state) =>
    draftId === null ? null : selectSandboxChoice(state, draftId),
  );
  const toggle = useMemo(
    () =>
      enabled && project !== null
        ? resolveSandboxToggle({
            isDraft: true,
            sandboxRepo,
            sandboxHasThread,
            repositoryIdentity: project.repositoryIdentity,
          })
        : HIDDEN,
    [enabled, project, sandboxHasThread, sandboxRepo],
  );
  return { toggle, choice, instance: sandboxInstanceToStart(toggle, choice) };
}
