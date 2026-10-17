import type { PlatformConnectionRegistration } from "@t3tools/client-runtime/connection";
import type { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  findSandboxProject,
  listSandboxes,
  sandboxRegistration,
  type SandboxDirectoryState,
  type SandboxEntry,
  useSandboxDirectoryStore,
} from "./directory";
import { presumedOperateEnvironmentsAtom } from "./presumedScopes";
import { borrowedServerConfig, seedSignature, seededSandboxShell } from "./seed";

type CacheStore = Persistence.EnvironmentCacheStore["Service"];

const DIRECTORY_POLL_INTERVAL = "3 seconds";

/** What each environment's cache was last seeded with, this page load. */
const seeded = new Map<string, string>();
/** Environments given another sandbox's server config, this page load. */
const borrowed = new Set<string>();

/**
 * Seeds the cache of each sandbox that has never run, so the client shows its
 * project, and its thread once started, before the sandbox answers. Runs
 * before the registrations are emitted: a client reads an environment's cache
 * when it registers it, and again when its registration changes.
 */
const seedNeverRun = Effect.fn("SandboxRegistrations.seedNeverRun")(function* (
  cache: CacheStore,
  state: SandboxDirectoryState,
) {
  const donors = state.entries.filter(
    (entry): entry is SandboxEntry & { environmentId: string } =>
      entry.ranAt !== null && entry.environmentId !== null,
  );
  for (const entry of state.entries) {
    if (entry.ranAt !== null || entry.environmentId === null) continue;
    const environmentId = EnvironmentId.make(entry.environmentId);
    const project = findSandboxProject(state.projects, entry.repo);
    const signature = seedSignature(entry, project);
    if (seeded.get(environmentId) !== signature) {
      yield* cache.saveShell(environmentId, seededSandboxShell(entry, project));
      seeded.set(environmentId, signature);
    }
    if (borrowed.has(environmentId)) continue;
    if (Option.isSome(yield* cache.loadServerConfig(environmentId))) {
      borrowed.add(environmentId);
      continue;
    }
    for (const donor of donors) {
      const config = yield* cache.loadServerConfig(EnvironmentId.make(donor.environmentId));
      if (Option.isNone(config)) continue;
      yield* cache.saveServerConfig(
        environmentId,
        borrowedServerConfig(config.value, environmentId),
      );
      borrowed.add(environmentId);
      break;
    }
  }
});

/** A project's unstarted sandbox takes its first thread through the control plane. */
function presumeUnstarted(state: SandboxDirectoryState) {
  const unstarted = state.entries.flatMap((entry) =>
    entry.status === "unstarted" && entry.environmentId !== null
      ? [EnvironmentId.make(entry.environmentId)]
      : [],
  );
  const current = appAtomRegistry.get(presumedOperateEnvironmentsAtom);
  if (current.size === unstarted.length && unstarted.every((id) => current.has(id))) return;
  appAtomRegistry.set(presumedOperateEnvironmentsAtom, new Set(unstarted));
}

const registrationsFor = (cache: CacheStore, state: SandboxDirectoryState) =>
  seedNeverRun(cache, state).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Could not seed a sandbox's cached shell.", { error }),
    ),
    Effect.ignore,
    Effect.tap(() => Effect.sync(() => presumeUnstarted(state))),
    Effect.as(
      state.entries.flatMap((entry): ReadonlyArray<PlatformConnectionRegistration> => {
        const registration = sandboxRegistration(entry);
        return registration === null ? [] : [registration];
      }),
    ),
  );

const directoryStates = Stream.callback<SandboxDirectoryState>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const current = useSandboxDirectoryStore.getState();
        if (current.loaded) Queue.offerUnsafe(queue, current);
        return useSandboxDirectoryStore.subscribe((state) => Queue.offerUnsafe(queue, state));
      }),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid),
  { bufferSize: 1, strategy: "sliding" },
);

/** Re-reads the directory on an interval; a failed read keeps the last one. */
const directoryPolls = Stream.tick(DIRECTORY_POLL_INTERVAL).pipe(
  Stream.mapEffect(() =>
    Effect.tryPromise(listSandboxes).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not read the sandbox directory.", { error }),
      ),
      Effect.ignore,
    ),
  ),
  Stream.drain,
);

/**
 * The platform environments the directory lists: one per sandbox, including
 * each project's unstarted one. Emits on every directory change, whether from
 * the poll or from this client starting a sandbox.
 */
export const sandboxRegistrations = (
  cache: CacheStore,
): Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>> =>
  Stream.merge(
    directoryStates.pipe(
      Stream.filter((state) => state.loaded),
      Stream.mapEffect((state) => registrationsFor(cache, state)),
    ),
    directoryPolls,
  );
