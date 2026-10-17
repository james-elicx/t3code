import {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellSnapshotJson,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { SandboxEntry, SandboxProjectEntry } from "./directory";

/**
 * What a client shows for a sandbox before its T3 server first answers: the
 * project the control plane keeps for its repository and, once a thread's
 * first message started it, that thread, preparing. Written to the
 * environment's cached shell, which the client renders until it connects;
 * the server's first snapshot then replaces it with the real project and
 * thread, under the same ids.
 */
export function seededSandboxShell(
  entry: SandboxEntry,
  project: SandboxProjectEntry | null,
): OrchestrationV2ShellSnapshot {
  const [owner = "", name = ""] = entry.repo.split("/");
  const createdAt =
    project?.createdAt ?? entry.pendingThread?.createdAt ?? new Date(0).toISOString();
  const workspaceRoot = `/workspace/${name}`;
  const repositoryPath = `${owner}/${name}`.toLowerCase();
  const pending = entry.pendingThread;
  return decodeShell({
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [
      {
        id: entry.projectId,
        title: project?.config.title ?? name,
        workspaceRoot,
        // As the sandbox's T3 server reports its clone, so it groups with the
        // same repository on every other machine and sandbox.
        repositoryIdentity: {
          canonicalKey: `github.com/${repositoryPath}`,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://github.com/${owner}/${name}.git`,
          },
          rootPath: workspaceRoot,
          displayName: repositoryPath,
          provider: "github",
          owner: owner.toLowerCase(),
          name: name.toLowerCase(),
        },
        defaultModelSelection: project?.config.defaultModelSelection ?? null,
        scripts: project?.config.scripts ?? [],
        createdAt,
        updatedAt: createdAt,
      },
    ],
    threads: pending
      ? [
          {
            createdBy: "user",
            creationSource: "web",
            id: pending.threadId,
            projectId: entry.projectId,
            title: pending.title,
            providerInstanceId: pending.modelSelection.instanceId,
            modelSelection: pending.modelSelection,
            runtimeMode: pending.runtimeMode,
            interactionMode: pending.interactionMode,
            branch: null,
            worktreePath: null,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: pending.threadId,
            },
            forkedFrom: null,
            activeProviderThreadId: null,
            latestRunId: null,
            activeRunId: null,
            activityRunStartedAt: pending.createdAt,
            activityRunStatus: "preparing",
            status: "idle",
            pendingRuntimeRequest: null,
            latestVisibleMessage: null,
            // Left unset so the draft keeps the composer until the real thread
            // arrives: the client promotes a draft once its thread has a message.
            latestUserMessageAt: null,
            hasActionableProposedPlan: false,
            itemCount: 0,
            visibleItemCount: 0,
            createdAt: pending.createdAt,
            updatedAt: pending.createdAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            deletedAt: null,
          },
        ]
      : [],
    archivedThreads: [],
  });
}

const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ShellSnapshotJson);

/**
 * Another sandbox's server config, as this one's until it answers: every
 * sandbox runs the same image and starts from the same settings, so its
 * providers and models are what the composer should offer.
 */
export function borrowedServerConfig(config: ServerConfig, environmentId: string): ServerConfig {
  return {
    ...config,
    environment: { ...config.environment, environmentId: EnvironmentId.make(environmentId) },
  };
}

/** Changes whenever the seeded shell would, so it is written only then. */
export function seedSignature(entry: SandboxEntry, project: SandboxProjectEntry | null): string {
  return JSON.stringify([entry.environmentId, entry.title, entry.pendingThread, project?.config]);
}
