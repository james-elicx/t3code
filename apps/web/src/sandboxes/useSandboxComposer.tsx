import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { MoonIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { DraftId } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";
import {
  isSandboxMode,
  type SandboxEntry,
  useSandboxDirectoryStore,
  wakeSandbox,
} from "./directory";
import {
  cancelSandboxPreparation,
  clearSandboxPreparation,
  prepareSandbox,
  sandboxSetupStep,
  useSandboxPreparationStore,
} from "./preparation";
import { useSandboxToggle } from "./useSandboxToggle";

const VIEW_INTERVAL_MS = 60_000;

/**
 * Keeps the sandbox an open thread lives in awake, booting it if it slept, and
 * reconnects once it is back. Returns true while it is not yet running.
 */
function useSandboxPresence(environmentId: EnvironmentId | null): boolean {
  const find = (entries: ReadonlyArray<SandboxEntry>) =>
    environmentId === null || !isSandboxMode()
      ? undefined
      : entries.find((candidate) => candidate.environmentId === environmentId);
  const sandboxId = useSandboxDirectoryStore((state) => find(state.entries)?.threadId ?? null);
  const status = useSandboxDirectoryStore((state) => find(state.entries)?.status ?? null);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  useEffect(() => {
    if (sandboxId === null) return;
    const view = () => void wakeSandbox(sandboxId).catch(() => undefined);
    view();
    const interval = setInterval(view, VIEW_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sandboxId]);

  // The connection backs off while the sandbox sleeps; skip the wait once it is up.
  const wasRunning = useRef(status === "running");
  useEffect(() => {
    const running = status === "running";
    if (running && !wasRunning.current && environmentId !== null) {
      void retryEnvironment(environmentId);
    }
    wasRunning.current = running;
  }, [environmentId, retryEnvironment, status]);

  return sandboxId !== null && status !== "running";
}

/**
 * Everything ChatView needs for sandboxes: a draft's first send starting one
 * when the toggle is on, its setup banner, and waking the one an open thread
 * lives in.
 */
export function useSandboxComposer(input: {
  readonly draftId: DraftId | null;
  readonly projectRef: ScopedProjectRef | null;
  readonly environmentId: EnvironmentId | null;
}) {
  const { draftId } = input;
  const { toggle, instance } = useSandboxToggle(draftId, input.projectRef);
  const preparation = useSandboxPreparationStore((state) =>
    draftId === null ? undefined : state.byDraft[draftId],
  );
  const waking = useSandboxPresence(input.environmentId);
  const repo = toggle.kind === "choose" || toggle.kind === "locked" ? toggle.repo : null;

  const start = useCallback(() => {
    if (draftId === null || repo === null || instance === null) return;
    void prepareSandbox(draftId, { repo, instance });
  }, [draftId, instance, repo]);

  /** Call first in `onSend`: true when this send is held for a new sandbox. */
  const interceptSend = useCallback(
    (hasAttachments: boolean): boolean => {
      if (draftId === null) return false;
      if (preparation?.phase === "ready") {
        // The draft is in its sandbox now; this is the held message going out.
        clearSandboxPreparation(draftId);
        return false;
      }
      if (preparation !== undefined && preparation.phase !== "failed") return true;
      if (instance === null) return false;
      if (hasAttachments) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Attachments can't start a sandbox",
            description: "Send the first message as text, then attach files in the sandbox.",
          }),
        );
        return true;
      }
      start();
      return true;
    },
    [draftId, instance, preparation, start],
  );

  const banner = useMemo<ComposerBannerStackItem | null>(() => {
    if (draftId !== null && preparation !== undefined && preparation.phase !== "ready") {
      if (preparation.phase === "failed") {
        return {
          id: `sandbox-setup:${preparation.sandboxId}`,
          variant: "error",
          icon: <TriangleAlertIcon />,
          title: "The sandbox did not start",
          description: preparation.error,
          actions: (
            <Button size="xs" variant="ghost" disabled={repo === null} onClick={start}>
              Retry
            </Button>
          ),
          dismissLabel: "Dismiss",
          onDismiss: () => clearSandboxPreparation(draftId),
        };
      }
      return {
        id: `sandbox-setup:${preparation.sandboxId}`,
        variant: "default",
        priority: "activity",
        icon: <Spinner size="sm" />,
        title: `Setting up a sandbox for ${preparation.repo}`,
        description: sandboxSetupStep(preparation),
        actions: (
          <Button size="xs" variant="ghost" onClick={() => void cancelSandboxPreparation(draftId)}>
            Cancel
          </Button>
        ),
      };
    }
    if (waking) {
      return {
        id: `sandbox-waking:${input.environmentId}`,
        variant: "default",
        priority: "activity",
        icon: <MoonIcon />,
        title: "Waking the sandbox…",
        description: "Its saved state is coming back. You can read the thread meanwhile.",
      };
    }
    return null;
  }, [draftId, input.environmentId, preparation, repo, start, waking]);

  return {
    interceptSend,
    banner,
    /** The composer waits for the sandbox; sending is held. */
    preparing: preparation !== undefined && preparation.phase !== "failed",
    waking,
    /** The draft has moved into its sandbox: ChatView sends the held message. */
    resendReady: preparation?.phase === "ready",
  };
}
