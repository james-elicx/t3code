import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  type PlatformConnectionRegistration,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
 * `starting` covers the container booting, the clone and T3 starting;
 * `restoring` is its T3 home coming back; `saving` precedes `asleep`.
 */
export type SandboxStatus = "asleep" | "starting" | "restoring" | "saving" | "running";

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
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

const DIRECTORY_POLL_INTERVAL = "3 seconds";

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

/** The environment a booted sandbox serves, or null until its T3 server first answers. */
export function sandboxRegistration(entry: SandboxEntry): BearerConnectionRegistration | null {
  if (entry.environmentId === null) return null;
  const environmentId = EnvironmentId.make(entry.environmentId);
  const connectionId = `sandbox:${entry.threadId}`;
  const label = `${entry.title} · ${entry.threadId}`;
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

interface SandboxDirectoryState {
  readonly entries: ReadonlyArray<SandboxEntry>;
}

/** The last directory read, for telling sandbox environments apart in the UI. */
export const useSandboxDirectoryStore = create<SandboxDirectoryState>(() => ({ entries: [] }));

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
  const entries = (await request<{ sandboxes: SandboxEntry[] }>("")).sandboxes;
  useSandboxDirectoryStore.setState({ entries });
  return entries;
}

export const getSandbox = (id: string) => request<SandboxEntry>(`/${id}`);

export const createSandbox = (input: {
  threadId: string;
  repo: string;
  title: string;
  instance?: SandboxInstance;
}) => request<SandboxEntry>("", { method: "POST", body: JSON.stringify(input) });

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

/**
 * The platform environments the directory lists, re-read on an interval. A
 * failed read emits nothing, so a network blip does not drop every sandbox.
 */
export const sandboxRegistrations: Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>> =
  Stream.tick(DIRECTORY_POLL_INTERVAL).pipe(
    Stream.mapEffect(() =>
      Effect.tryPromise(listSandboxes).pipe(
        Effect.map((entries): ReadonlyArray<PlatformConnectionRegistration> | undefined =>
          entries.flatMap((entry) => {
            const registration = sandboxRegistration(entry);
            return registration === null ? [] : [registration];
          }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Could not read the sandbox directory.", { error }),
        ),
        Effect.orElseSucceed(() => undefined),
      ),
    ),
    Stream.filter(
      (
        registrations: ReadonlyArray<PlatformConnectionRegistration> | undefined,
      ): registrations is ReadonlyArray<PlatformConnectionRegistration> =>
        registrations !== undefined,
    ),
  );
