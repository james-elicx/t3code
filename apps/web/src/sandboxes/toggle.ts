import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  repositoryGroupingKeyOf,
  type RepositoryIdentity,
  type ScopedProjectRef,
} from "@t3tools/contracts";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import type { SandboxEntry } from "./directory";

/**
 * The composer's sandbox toggle. On, the draft is in its project's unstarted
 * sandbox, so its first message starts that sandbox; off, it is on one of
 * your machines. Either way the draft is an ordinary draft on an ordinary
 * environment, and the toggle only moves it between them.
 */
export type SandboxToggle =
  /** Not a draft, or not in sandbox mode. */
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "choose";
      readonly repo: string;
      readonly on: boolean;
      /** Where "on" moves the draft: the project's unstarted sandbox, once the control plane has one. */
      readonly sandboxProjectRef: ScopedProjectRef | null;
      /** Where "off" moves it: the same repository on one of your machines, if any has it. */
      readonly machineProjectRef: ScopedProjectRef | null;
    };

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

interface ProjectCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

export function resolveSandboxToggle(input: {
  readonly isDraft: boolean;
  readonly project: ProjectCandidate | null;
  readonly entries: ReadonlyArray<SandboxEntry>;
  readonly projects: ReadonlyArray<ProjectCandidate>;
}): SandboxToggle {
  const { project, entries } = input;
  if (!input.isDraft || project === null) return { kind: "hidden" };
  const repo = sandboxRepoOf(project.repositoryIdentity);
  if (repo === null) {
    return { kind: "unavailable", reason: "Sandboxes need a project with a GitHub remote." };
  }
  const isSandbox = (environmentId: EnvironmentId) =>
    entries.some((entry) => entry.environmentId === environmentId);
  const sameRepo = (candidate: ProjectCandidate) =>
    sandboxRepoOf(candidate.repositoryIdentity)?.toLowerCase() === repo.toLowerCase();
  const slot =
    entries.find(
      (entry) =>
        entry.status === "unstarted" &&
        entry.environmentId !== null &&
        entry.repo.toLowerCase() === repo.toLowerCase(),
    ) ?? null;
  const machine = input.projects.find(
    (candidate) => !isSandbox(candidate.environmentId) && sameRepo(candidate),
  );
  return {
    kind: "choose",
    repo,
    on: isSandbox(project.environmentId),
    sandboxProjectRef: slot
      ? scopeProjectRef(
          EnvironmentId.make(slot.environmentId ?? ""),
          ProjectId.make(slot.projectId),
        )
      : null,
    machineProjectRef: machine ? scopeProjectRef(machine.environmentId, machine.id) : null,
  };
}

/**
 * Where a draft belongs: a draft in a sandbox that holds another thread moves
 * to the project's unstarted one, since a sandbox holds one thread.
 */
export function sandboxDraftTarget(
  toggle: SandboxToggle,
  sandboxHoldsAnotherThread: boolean,
): ScopedProjectRef | null {
  if (toggle.kind !== "choose" || !toggle.on || !sandboxHoldsAnotherThread) return null;
  return toggle.sandboxProjectRef;
}

/** Moves a draft to another environment's copy of its project, as "Run on" does. */
export function moveDraft(draftId: DraftId, projectRef: ScopedProjectRef): void {
  // A sandbox's checkout is its workspace; a worktree would live outside what it saves.
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    projectRef,
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
    environmentSelection: "manual",
    loadBalancedEnvironmentId: null,
  });
}
