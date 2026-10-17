import type { PlatformConnectionRegistration } from "@t3tools/client-runtime/connection";
import type { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  fetchSharedServerConfig,
  findSandboxProject,
  listSandboxes,
  sandboxRegistration,
  type SandboxDirectoryState,
  useSandboxDirectoryStore,
} from "./directory";
import { presumedOperateEnvironmentsAtom } from "./presumedScopes";
import {
  borrowedServerConfig,
  decodeSharedServerConfig,
  seedSignature,
  seededSandboxShell,
} from "./seed";

type CacheStore = Persistence.EnvironmentCacheStore["Service"];

const DIRECTORY_POLL_INTERVAL = "3 seconds";

/** What each environment's cache was last seeded with, this page load. */
const seeded = new Map<string, string>();
/** Environments given the control plane's server config, this page load. */
const borrowed = new Set<string>();
/** The control plane's server config, read once a page load once it has one. */
let shared = Option.none<ServerConfig>();

/**
 * Seeds the cache of each sandbox that has never run, so the client shows its
 * project, its models, and its thread once started, before the sandbox
 * answers. Runs before the registrations are emitted: a client reads an
 * environment's cache when it registers it, and again when its registration
 * changes.
 */
const seedNeverRun = Effect.fn("SandboxRegistrations.seedNeverRun")(function* (
  cache: CacheStore,
  state: SandboxDirectoryState,
) {
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
    const config = yield* sharedServerConfig().pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not read the sandboxes' server config.", { error }),
      ),
      Effect.orElseSucceed(() => Option.none<ServerConfig>()),
    );
    if (Option.isNone(config)) continue;
    yield* cache.saveServerConfig(environmentId, borrowedServerConfig(config.value, environmentId));
    borrowed.add(environmentId);
  }
});

/**
 * The server config the control plane keeps from the last sandbox that
 * booted: every sandbox runs the same image, so it is what one that has not
 * started offers. None until the control plane's first boot.
 */
const sharedServerConfig = Effect.fn("SandboxRegistrations.sharedServerConfig")(function* () {
  if (Option.isSome(shared)) return shared;
  const json = yield* Effect.tryPromise(fetchSharedServerConfig);
  if (json === null) return Option.none<ServerConfig>();
  shared = Option.some(yield* decodeSharedServerConfig(json));
  return shared;
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
        // Registered again once seeded with a server config, so the client reads it.
        const configured =
          entry.ranAt !== null || entry.environmentId === null || borrowed.has(entry.environmentId);
        const registration = sandboxRegistration(entry, configured);
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
