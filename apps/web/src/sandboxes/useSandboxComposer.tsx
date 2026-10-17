import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { BoxIcon, MoonIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { WORKTREE_SETUP_LABELS } from "../components/chat/WorktreeSetupCard";
import type { DraftId } from "../composerDraftStore";
import { useServerConfigs } from "../state/entities";
import {
  isSandboxMode,
  type SandboxEntry,
  useSandboxDirectoryStore,
  wakeSandbox,
} from "./directory";
import { SANDBOX_SETUP_LABELS, useSandboxSetup } from "./setup";
import { useSandboxDraftPlacement, useSandboxToggle } from "./useSandboxToggle";

const VIEW_INTERVAL_MS = 60_000;

const sandboxFor = (entries: ReadonlyArray<SandboxEntry>, environmentId: EnvironmentId | null) =>
  environmentId === null || !isSandboxMode()
    ? undefined
    : entries.find((candidate) => candidate.environmentId === environmentId);

/** Keeps the sandbox an open thread lives in awake, booting it if it slept. */
function useSandboxPresence(environmentId: EnvironmentId | null) {
  const sandboxId = useSandboxDirectoryStore(
    (state) => sandboxFor(state.entries, environmentId)?.threadId ?? null,
  );
  const status = useSandboxDirectoryStore(
    (state) => sandboxFor(state.entries, environmentId)?.status ?? null,
  );
  const hasRun = useSandboxDirectoryStore(
    (state) => sandboxFor(state.entries, environmentId)?.ranAt != null,
  );
  const unstarted = status === "unstarted";

  useEffect(() => {
    // An unstarted sandbox starts only with a thread's first message.
    if (sandboxId === null || unstarted) return;
    const view = () => void wakeSandbox(sandboxId).catch(() => undefined);
    view();
    const interval = setInterval(view, VIEW_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sandboxId, unstarted]);

  return { sandboxId, status, hasRun };
}

/**
 * Everything ChatView needs for sandboxes: the draft's placement, the setup
 * card while a new sandbox boots, and waking the one an open thread lives in.
 */
export function useSandboxComposer(input: {
  readonly draftId: DraftId | null;
  readonly projectRef: ScopedProjectRef | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) {
  const toggle = useSandboxToggle(input.draftId, input.projectRef);
  useSandboxDraftPlacement(input.draftId, input.projectRef, toggle);
  const presence = useSandboxPresence(input.environmentId);
  const configs = useServerConfigs();
  const setup = useSandboxSetup(input.environmentId, input.threadId);
  const { sandboxId, status, hasRun } = presence;
  const isSandbox = sandboxId !== null;
  const waking = isSandbox && hasRun && status !== "running";
  const booting = isSandbox && !hasRun && status !== "unstarted";
  // Only before the control plane's first boot, which it starts on its own.
  const awaitingConfig = isSandbox && status === "unstarted" && !configs.has(input.environmentId);

  const banner = useMemo<ComposerBannerStackItem | null>(() => {
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
    // A thread's own setup card covers its boot; this is a boot with no thread yet.
    if (booting && setup === null) {
      return {
        id: `sandbox-booting:${input.environmentId}`,
        variant: "default",
        priority: "activity",
        icon: <BoxIcon />,
        title: "Setting up a sandbox…",
        description: "It clones the repository and starts T3.",
      };
    }
    if (awaitingConfig) {
      return {
        id: `sandbox-config:${input.environmentId}`,
        variant: "default",
        priority: "activity",
        icon: <BoxIcon />,
        title: "Getting sandboxes ready…",
        description: "The control plane is starting T3 once to learn which models sandboxes offer.",
      };
    }
    return null;
  }, [awaitingConfig, booting, input.environmentId, setup, waking]);

  return {
    banner,
    /** The setup card for this thread while its new sandbox boots. */
    setup,
    setupLabels: setup === null ? WORKTREE_SETUP_LABELS : SANDBOX_SETUP_LABELS,
    /**
     * The environment is a sandbox that is not running: its own banner or card
     * says so, and an unstarted one takes a draft's first message anyway.
     */
    unreachableByDesign: isSandbox && status !== "running",
    unstarted: isSandbox && status === "unstarted",
  };
}
