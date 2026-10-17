import type { ScopedProjectRef } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useEnvironmentThreadRefs, useProject, useProjects } from "../state/entities";
import { isSandboxMode, useSandboxDirectoryStore } from "./directory";
import { moveDraft, resolveSandboxToggle, sandboxDraftTarget, type SandboxToggle } from "./toggle";

const HIDDEN: SandboxToggle = { kind: "hidden" };

/** The sandbox toggle for a draft in the composer. */
export function useSandboxToggle(draftId: DraftId | null, projectRef: ScopedProjectRef | null) {
  const enabled = draftId !== null && projectRef !== null && isSandboxMode();
  const project = useProject(enabled ? projectRef : null);
  const projects = useProjects();
  const entries = useSandboxDirectoryStore((state) => state.entries);
  return useMemo(
    () => (enabled ? resolveSandboxToggle({ isDraft: true, project, entries, projects }) : HIDDEN),
    [enabled, entries, project, projects],
  );
}

/**
 * Keeps a draft out of sandboxes that hold another thread, moving it to the
 * project's unstarted sandbox instead.
 */
export function useSandboxDraftPlacement(
  draftId: DraftId | null,
  projectRef: ScopedProjectRef | null,
  toggle: SandboxToggle,
) {
  const draftThreadId = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.threadId ?? null),
  );
  const threadRefs = useEnvironmentThreadRefs(
    toggle.kind === "choose" && toggle.on ? (projectRef?.environmentId ?? null) : null,
  );
  const holdsAnotherThread = threadRefs.some((ref) => ref.threadId !== draftThreadId);
  const target = sandboxDraftTarget(toggle, holdsAnotherThread);
  useEffect(() => {
    if (draftId !== null && target !== null) moveDraft(draftId, target);
  }, [draftId, target]);
}
