import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationMessageContext,
  type ProjectScript,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { isHostedStaticApp } from "../hostedPairing";
import { randomUUID } from "../lib/utils";

/**
 * Sandboxed threads: when this app is served by the sandbox control plane
 * (infra/sandbox-control), each thread runs in its own sandbox, a full T3
 * server behind the control plane, which lists them here. Each becomes a
 * platform environment that the app connects to like any other.
 */

/**
 * `unstarted` is a project's next sandbox, with no container until a thread's
 * first message starts it; `starting` covers the container booting, the clone
 * and T3 starting; `restoring` is its T3 home coming back; `saving` precedes
 * `asleep`.
 */
export type SandboxStatus =
  | "unstarted"
  | "asleep"
  | "starting"
  | "restoring"
  | "saving"
  | "running";

/** Where a sandbox's first boot is. */
export type SandboxSetupStep = "container" | "clone" | "launch";

/** The thread a started sandbox launches once its T3 server is up. */
export interface SandboxPendingThread {
  readonly threadId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Sizes a sandbox may ask for. One today; the toggle lists each. */
export const SANDBOX_INSTANCES = ["standard-1"] as const;
export type SandboxInstance = (typeof SANDBOX_INSTANCES)[number];

/** A sandbox as the control plane's directory lists it. */
export interface SandboxEntry {
  readonly threadId: string;
  readonly title: string;
  readonly status: SandboxStatus;
  /** `owner/name` on GitHub. */
  readonly repo: string;
  /** The project the control plane creates in the sandbox for its repo. */
  readonly projectId: string;
  readonly instance: SandboxInstance;
  readonly environmentId: string | null;
  readonly lastError: string | null;
  /** When its T3 server first answered; until then clients show what the control plane knows. */
  readonly ranAt: string | null;
  readonly setupStep: SandboxSetupStep | null;
  readonly pendingThread: SandboxPendingThread | null;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/** A GitHub repository the control plane keeps as a project, with its editable config. */
export interface SandboxProjectEntry {
  readonly repo: string;
  readonly createdAt: string;
  readonly config: {
    readonly title: string;
    readonly defaultModelSelection: ModelSelection | null;
    readonly scripts: ReadonlyArray<ProjectScript>;
  };
}

/** A thread's first message, as the control plane launches it in a new sandbox. */
export interface SandboxLaunch {
  readonly commandId: string;
  readonly threadId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
  readonly initialMessage: {
    readonly messageId: string;
    readonly text: string;
    readonly context?: OrchestrationMessageContext;
  };
}

/**
 * The control plane adds each sandbox's own credential to every request it
 * proxies, replacing this one. The browser never holds a real sandbox token.
 */
const PROXY_CREDENTIAL = "sandbox-proxy";

/** The directory endpoint, set at build time by the control plane's web build. */
export function sandboxDirectoryUrl(): string | null {
  return import.meta.env.VITE_SANDBOX_DIRECTORY_URL?.trim() || null;
}

/** True when this app is the control plane's hosted client. */
export function isSandboxMode(): boolean {
  return sandboxDirectoryUrl() !== null && isHostedStaticApp();
}

/** Sandbox ids are DNS labels: they name the sandbox's own subdomain. */
export const SANDBOX_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function newSandboxId(): string {
  return `t-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

/**
 * The environment a sandbox serves. A project's unstarted sandbox has one too,
 * fixed by the control plane, so its project lists before anything runs. Its
 * label changes when a thread starts it, which makes the client re-read the
 * environment's cached shell (see registrations.ts).
 */
export function sandboxRegistration(entry: SandboxEntry): BearerConnectionRegistration | null {
  if (entry.environmentId === null) return null;
  const environmentId = EnvironmentId.make(entry.environmentId);
  const connectionId = `sandbox:${entry.threadId}`;
  const label =
    entry.status === "unstarted"
      ? `New sandbox · ${entry.repo}`
      : `${entry.title} · ${entry.threadId}`;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, label, connectionId }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId,
      label,
      httpBaseUrl: entry.httpBaseUrl,
      wsBaseUrl: entry.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({ token: PROXY_CREDENTIAL }),
  });
}

export interface SandboxDirectoryState {
  readonly entries: ReadonlyArray<SandboxEntry>;
  readonly projects: ReadonlyArray<SandboxProjectEntry>;
  /** False until the first read, so nothing mistakes "not read yet" for "none". */
  readonly loaded: boolean;
}

/** The last directory read, for telling sandbox environments apart in the UI. */
export const useSandboxDirectoryStore = create<SandboxDirectoryState>(() => ({
  entries: [],
  projects: [],
  loaded: false,
}));

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The project's unstarted sandbox: where its next thread starts. */
export function findSlotForRepo(
  entries: ReadonlyArray<SandboxEntry>,
  repo: string,
): SandboxEntry | null {
  return (
    entries.find(
      (entry) =>
        entry.status === "unstarted" && entry.environmentId !== null && sameRepo(entry.repo, repo),
    ) ?? null
  );
}

export function findSandboxProject(
  projects: ReadonlyArray<SandboxProjectEntry>,
  repo: string,
): SandboxProjectEntry | null {
  return projects.find((project) => sameRepo(project.repo, repo)) ?? null;
}

export function findSandboxForEnvironment(
  entries: ReadonlyArray<SandboxEntry>,
  environmentId: EnvironmentId,
): SandboxEntry | null {
  return entries.find((entry) => entry.environmentId === environmentId) ?? null;
}

/** The environments that are sandboxes; re-renders only when that set changes. */
export function useSandboxEnvironmentIds(): ReadonlyArray<string> {
  return useSandboxDirectoryStore(
    useShallow((state) =>
      state.entries.flatMap((entry) => (entry.environmentId ? [entry.environmentId] : [])),
    ),
  );
}

export function readSandboxForEnvironment(environmentId: EnvironmentId): SandboxEntry | null {
  return findSandboxForEnvironment(useSandboxDirectoryStore.getState().entries, environmentId);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = sandboxDirectoryUrl();
  if (url === null) throw new Error("Sandboxes are not available in this app.");
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw new Error((await response.text()).trim() || `Request failed (${response.status}).`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

export async function listSandboxes(): Promise<ReadonlyArray<SandboxEntry>> {
  const { sandboxes, projects } = await request<{
    sandboxes: SandboxEntry[];
    projects: SandboxProjectEntry[];
  }>("");
  useSandboxDirectoryStore.setState({ entries: sandboxes, projects, loaded: true });
  return sandboxes;
}

/** Puts a summary the control plane just returned into the store, ahead of the next read. */
function storeEntry(entry: SandboxEntry) {
  useSandboxDirectoryStore.setState(({ entries }) => ({
    entries: entries.some((candidate) => candidate.threadId === entry.threadId)
      ? entries.map((candidate) => (candidate.threadId === entry.threadId ? entry : candidate))
      : [entry, ...entries],
  }));
}

export const getSandbox = (id: string) => request<SandboxEntry>(`/${id}`);

/**
 * Starts a project's unstarted sandbox, with the thread its first message
 * begins, or with none to have its models before any thread.
 */
export async function startSandbox(
  id: string,
  input: { readonly launch?: SandboxLaunch; readonly instance?: SandboxInstance },
): Promise<SandboxEntry> {
  const entry = await request<SandboxEntry>(`/${id}/start`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  storeEntry(entry);
  // The project has a fresh unstarted sandbox for its next thread now.
  void listSandboxes().catch(() => undefined);
  return entry;
}

/** Adds a GitHub repository as a project, with an unstarted sandbox for its first thread. */
export async function addSandboxProject(repo: string): Promise<void> {
  await request<SandboxProjectEntry>("/projects", {
    method: "POST",
    body: JSON.stringify({ repo }),
  });
  await listSandboxes();
}

/** Forgets the project and its unstarted sandbox; sandboxes holding threads stay. */
export async function removeSandboxProject(repo: string): Promise<void> {
  await request<null>(`/projects/${repo}`, { method: "DELETE" });
  await listSandboxes();
}

/**
 * Marks the sandbox as viewed, booting it if it was asleep. An open thread
 * calls it every minute; a sandbox nobody views sleeps once its work is done.
 */
export const wakeSandbox = (id: string) => request<SandboxEntry>(`/${id}/wake`, { method: "POST" });

export async function deleteSandbox(id: string): Promise<void> {
  await request<null>(`/${id}`, { method: "DELETE" });
  useSandboxDirectoryStore.setState(({ entries }) => ({
    entries: entries.filter((entry) => entry.threadId !== id),
  }));
}
