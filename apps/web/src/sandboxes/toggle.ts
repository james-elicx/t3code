import { repositoryGroupingKeyOf, type RepositoryIdentity } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftId } from "../composerDraftStore";
import { SANDBOX_INSTANCES, type SandboxInstance } from "./directory";

/**
 * The composer's sandbox toggle: whether a draft's first message starts a new
 * sandbox for its project's repository, or goes to the machine it is on.
 */
export type SandboxToggle =
  /** Not offered: a started thread, or a draft already in a sandbox made for it. */
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "choose"; readonly repo: string }
  /** The draft is in a sandbox that has its thread, so it can only start another. */
  | { readonly kind: "locked"; readonly repo: string };

const GITHUB_REPOSITORY_KEY = /^github\.com\/([\w.-]+)\/([\w.-]+)$/;

/**
 * The GitHub repository (`owner/name`) a sandbox for this checkout clones: its
 * own remote, so a fork's sandbox pushes to the fork. Null off GitHub.
 */
export function sandboxRepoOf(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) return null;
  const match = GITHUB_REPOSITORY_KEY.exec(repositoryGroupingKeyOf(identity));
  return match ? `${match[1]}/${match[2]}` : null;
}

export function resolveSandboxToggle(input: {
  readonly isDraft: boolean;
  /** The repository of the sandbox the draft's environment is, if it is one. */
  readonly sandboxRepo: string | null;
  readonly sandboxHasThread: boolean;
  readonly repositoryIdentity: RepositoryIdentity | null | undefined;
}): SandboxToggle {
  if (!input.isDraft) return { kind: "hidden" };
  if (input.sandboxRepo !== null) {
    // A sandbox holds one thread: an empty one takes this draft's.
    return input.sandboxHasThread
      ? { kind: "locked", repo: input.sandboxRepo }
      : { kind: "hidden" };
  }
  const repo = sandboxRepoOf(input.repositoryIdentity);
  return repo === null
    ? { kind: "unavailable", reason: "Sandboxes need a project with a GitHub remote." }
    : { kind: "choose", repo };
}

/** The size the draft's first message starts a sandbox at, or null to send it where it is. */
export function sandboxInstanceToStart(
  toggle: SandboxToggle,
  choice: SandboxInstance | null,
): SandboxInstance | null {
  if (toggle.kind === "locked") return choice ?? SANDBOX_INSTANCES[0];
  return toggle.kind === "choose" ? choice : null;
}

const LAST_CHOICE_KEY = "t3code:sandbox:last-choice";

function parseChoice(value: string | null): SandboxInstance | null {
  return SANDBOX_INSTANCES.find((instance) => instance === value) ?? null;
}

interface SandboxChoiceState {
  /** Each draft's choice; a draft without one uses the last choice made. */
  readonly byDraft: Readonly<Record<DraftId, SandboxInstance | null>>;
  readonly last: SandboxInstance | null;
}

export const useSandboxChoiceStore = create<SandboxChoiceState>(() => ({
  byDraft: {},
  last:
    typeof localStorage === "undefined" ? null : parseChoice(localStorage.getItem(LAST_CHOICE_KEY)),
}));

export function selectSandboxChoice(state: SandboxChoiceState, draftId: DraftId) {
  return draftId in state.byDraft ? (state.byDraft[draftId] ?? null) : state.last;
}

export function setSandboxChoice(draftId: DraftId, choice: SandboxInstance | null): void {
  localStorage.setItem(LAST_CHOICE_KEY, choice ?? "off");
  useSandboxChoiceStore.setState(({ byDraft }) => ({
    byDraft: { ...byDraft, [draftId]: choice },
    last: choice,
  }));
}
