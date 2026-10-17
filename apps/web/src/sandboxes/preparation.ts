import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { waitForProject } from "../state/entities";
import {
  createSandbox,
  deleteSandbox,
  newSandboxId,
  type SandboxEntry,
  type SandboxInstance,
  type SandboxStatus,
  useSandboxDirectoryStore,
} from "./directory";

/** How long a new sandbox gets to clone, start T3 and connect. */
const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * A draft whose first message is waiting on a new sandbox. Once `ready`, the
 * draft points at the sandbox's project and the composer sends the message.
 */
export type SandboxPreparation =
  | {
      readonly phase: "creating" | "booting" | "connecting";
      readonly sandboxId: string;
      readonly repo: string;
      readonly status: SandboxStatus | null;
    }
  | { readonly phase: "ready"; readonly sandboxId: string; readonly projectRef: ScopedProjectRef }
  | { readonly phase: "failed"; readonly sandboxId: string; readonly error: string };

interface PreparationState {
  readonly byDraft: Readonly<Record<DraftId, SandboxPreparation>>;
}

export const useSandboxPreparationStore = create<PreparationState>(() => ({ byDraft: {} }));

const current = (draftId: DraftId) => useSandboxPreparationStore.getState().byDraft[draftId];

function update(draftId: DraftId, sandboxId: string, next: SandboxPreparation) {
  // A cancelled or restarted preparation no longer owns the draft.
  if (current(draftId)?.sandboxId !== sandboxId) return false;
  useSandboxPreparationStore.setState(({ byDraft }) => ({
    byDraft: { ...byDraft, [draftId]: next },
  }));
  return true;
}

/** What a preparation is waiting on, for its setup banner. */
export function sandboxSetupStep(preparation: SandboxPreparation): string {
  switch (preparation.phase) {
    case "creating":
      return "Creating the sandbox…";
    case "booting":
      return preparation.status === "restoring"
        ? "Restoring its saved state…"
        : "Cloning the repository and starting T3…";
    case "connecting":
      return "Connecting…";
    case "ready":
      return "Sending your message…";
    case "failed":
      return preparation.error;
  }
}

export function clearSandboxPreparation(draftId: DraftId): void {
  useSandboxPreparationStore.setState(({ byDraft }) => {
    const { [draftId]: _removed, ...rest } = byDraft;
    return { byDraft: rest };
  });
}

/** Waits for the directory poll to list the sandbox with its environment. */
function waitForEnvironment(
  draftId: DraftId,
  sandboxId: string,
  repo: string,
): Promise<SandboxEntry> {
  return new Promise((resolve, reject) => {
    const check = ({ entries }: { entries: ReadonlyArray<SandboxEntry> }) => {
      if (current(draftId)?.sandboxId !== sandboxId) {
        finish();
        reject(new Error("cancelled"));
        return;
      }
      const entry = entries.find((candidate) => candidate.threadId === sandboxId);
      if (!entry) return;
      if (entry.lastError) {
        finish();
        reject(new Error(entry.lastError));
      } else if (entry.environmentId) {
        finish();
        resolve(entry);
      } else {
        update(draftId, sandboxId, { phase: "booting", sandboxId, repo, status: entry.status });
      }
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error("The sandbox took too long to start."));
    }, PREPARE_TIMEOUT_MS);
    const unsubscribe = useSandboxDirectoryStore.subscribe(check);
    const unsubscribeCancel = useSandboxPreparationStore.subscribe(() => {
      if (current(draftId)?.sandboxId !== sandboxId) check(useSandboxDirectoryStore.getState());
    });
    function finish() {
      clearTimeout(timeout);
      unsubscribe();
      unsubscribeCancel();
    }
    check(useSandboxDirectoryStore.getState());
  });
}

/**
 * Starts a sandbox for the draft's repository and moves the draft into it:
 * its project, on the sandbox's own checkout. The composer keeps the message
 * and sends it once this reports `ready`.
 */
export async function prepareSandbox(
  draftId: DraftId,
  input: { readonly repo: string; readonly instance: SandboxInstance },
): Promise<void> {
  const sandboxId = newSandboxId();
  useSandboxPreparationStore.setState(({ byDraft }) => ({
    byDraft: {
      ...byDraft,
      [draftId]: { phase: "creating", sandboxId, repo: input.repo, status: null },
    },
  }));
  try {
    await createSandbox({
      threadId: sandboxId,
      repo: input.repo,
      title: input.repo,
      instance: input.instance,
    });
    const entry = await waitForEnvironment(draftId, sandboxId, input.repo);
    const connecting: SandboxPreparation = {
      phase: "connecting",
      sandboxId,
      repo: input.repo,
      status: entry.status,
    };
    if (!update(draftId, sandboxId, connecting)) return;
    const projectRef = scopeProjectRef(
      EnvironmentId.make(entry.environmentId ?? ""),
      ProjectId.make(entry.projectId),
    );
    await waitForProject(projectRef, PREPARE_TIMEOUT_MS).catch(() => {
      throw new Error("The sandbox started, but this app could not connect to it.");
    });
    if (current(draftId)?.sandboxId !== sandboxId) return;
    // The sandbox's checkout is its workspace; a worktree would live outside what it saves.
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      projectRef,
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
    update(draftId, sandboxId, { phase: "ready", sandboxId, projectRef });
  } catch (error) {
    // Cancel deletes the sandbox, but a create still in flight then may have made it after.
    if (error instanceof Error && error.message === "cancelled") {
      await deleteSandbox(sandboxId).catch(() => undefined);
      return;
    }
    const failed = update(draftId, sandboxId, {
      phase: "failed",
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    // A retry starts a fresh sandbox, so this one would only linger.
    if (failed) await deleteSandbox(sandboxId).catch(() => undefined);
  }
}

/** Stops a preparation and deletes its sandbox; the draft stays where it was. */
export async function cancelSandboxPreparation(draftId: DraftId): Promise<void> {
  const preparation = current(draftId);
  if (!preparation || preparation.phase === "ready") return;
  clearSandboxPreparation(draftId);
  await deleteSandbox(preparation.sandboxId).catch(() => undefined);
}
