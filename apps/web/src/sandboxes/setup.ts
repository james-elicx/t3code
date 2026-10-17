import type {
  EnvironmentId,
  WorktreeSetupSnapshot,
  WorktreeSetupStage,
  WorktreeSetupStageId,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import type { WorktreeSetupLabels } from "../components/chat/WorktreeSetupCard";
import { type SandboxEntry, type SandboxSetupStep, useSandboxDirectoryStore } from "./directory";

/**
 * A new sandbox's first boot, in the worktree setup card's shape: the card a
 * thread shows while its worktree is made shows the sandbox being made
 * instead. Stage ids are the card's own; `SANDBOX_SETUP_LABELS` names them.
 */
const STEPS: ReadonlyArray<{ readonly step: SandboxSetupStep; readonly id: WorktreeSetupStageId }> =
  [
    { step: "container", id: "fetch" },
    { step: "clone", id: "checkout" },
    { step: "launch", id: "agent" },
  ];

const STAGE_LABELS: Partial<Record<WorktreeSetupStageId, string>> = {
  fetch: "Start sandbox",
  checkout: "Clone repository and start T3",
  agent: "Start thread",
};

export const SANDBOX_SETUP_LABELS: WorktreeSetupLabels = {
  subject: "sandbox",
  stage: (id) => STAGE_LABELS[id] ?? id,
};

type SetupState = Pick<SandboxEntry, "ranAt" | "setupStep" | "lastError" | "pendingThread">;

/**
 * The setup card for a thread whose sandbox is starting, or null once the
 * sandbox runs (its own T3 server shows the thread from then on) or for any
 * other thread.
 */
export function sandboxSetupSnapshot(
  entry: SetupState,
  threadId: string,
): WorktreeSetupSnapshot | null {
  const pending = entry.pendingThread;
  if (pending === null || pending.threadId !== threadId) return null;
  // A failed boot is retried by the control plane on its next tick. A sandbox
  // that runs with its thread still pending could not launch it.
  const failed = entry.ranAt !== null || (entry.lastError !== null && entry.setupStep === null);
  const current = STEPS.findIndex(
    ({ step }) => step === (entry.ranAt !== null ? "launch" : (entry.setupStep ?? "container")),
  );
  const stages = STEPS.map(({ id }, index): WorktreeSetupStage => ({
    id,
    status: index < current ? "done" : index > current ? "pending" : failed ? "failed" : "running",
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: null,
    tail: [],
  }));
  return {
    threadId: ThreadId.make(threadId),
    phase: failed ? "failed" : "running",
    startedAt: pending.createdAt,
    endedAt: null,
    branch: null,
    baseRef: null,
    worktreePath: null,
    setupScript: null,
    stages,
    error: failed ? (entry.lastError ?? "The thread did not start.").slice(0, 1000) : null,
    sequence: 0,
  };
}

/** The setup card for the thread a draft or route shows, while its sandbox starts. */
export function useSandboxSetup(
  environmentId: EnvironmentId,
  threadId: string,
): WorktreeSetupSnapshot | null {
  // What the card shows, as a string, so the directory's polls don't re-render the timeline.
  const key = useSandboxDirectoryStore((state) => {
    const entry = state.entries.find(
      (candidate) =>
        candidate.environmentId === environmentId && candidate.pendingThread?.threadId === threadId,
    );
    if (!entry) return null;
    const { ranAt, setupStep, lastError, pendingThread } = entry;
    return JSON.stringify({ ranAt, setupStep, lastError, pendingThread } satisfies SetupState);
  });
  return useMemo(
    () => (key === null ? null : sandboxSetupSnapshot(JSON.parse(key) as SetupState, threadId)),
    [key, threadId],
  );
}
