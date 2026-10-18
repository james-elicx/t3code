import type { DirectoryBackupRecord } from "@cloudflare/sandbox";

/**
 * Each project's dependency cache: every node_modules of a pnpm install of its
 * default branch, saved to R2. A new sandbox restores it while it clones, and
 * pnpm then only adds and removes what the checkout's lockfile changed since.
 *
 * Only the control plane writes caches, from a builder container that runs no
 * agent and installs nothing but the default branch's lockfile; a thread's
 * sandbox can only read its project's. Whatever ends up in a cache runs in
 * every sandbox after it, so no sandbox an agent has worked in may make one.
 */

/** Where the builder leaves the cache and a sandbox restores it (see container/deps.sh). */
export const DEPS_CACHE_DIR = "/var/cache/t3-deps";
/** The background install's state in the container: `<state> <pid>`. */
export const DEPS_STATUS_PATH = "/run/t3-sandbox-deps";
/** Where the control plane tells the container's install how restoring the cache went. */
export const DEPS_RESTORED_MARKER = "/run/t3-sandbox-deps-restored";
/** What the image's node_modules are good for: its Node, pnpm and architecture. */
export const TOOLCHAIN_PATH = "/opt/t3/toolchain";
/** A build that has not finished by now is presumed lost, and another may start. */
export const DEPS_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
/** A lockfile whose build failed is not tried again before this. */
export const DEPS_RETRY_FAILED_MS = 6 * 60 * 60 * 1000;

export interface DepsCache {
  readonly backup: DirectoryBackupRecord;
  /** SHA-256 of the pnpm-lock.yaml it was installed from. */
  readonly lockfile: string;
  /** The image's toolchain (see TOOLCHAIN_PATH); a sandbox on another restores nothing. */
  readonly toolchain: string;
  readonly commit: string;
  readonly builtAt: string;
}

export interface DepsState {
  readonly cache?: DepsCache;
  /** The cache before this one, kept until the next build: sandboxes may still be restoring it. */
  readonly previous?: DirectoryBackupRecord;
  /** The default branch as last checked, and its lockfile's hash (null: none). */
  readonly checked?: { readonly commit: string; readonly lockfile: string | null };
  /** The builder sandbox running now. */
  readonly building?: { readonly id: string; readonly startedAt: string };
  readonly failed?: {
    readonly lockfile: string | null;
    readonly at: string;
    readonly error: string;
  };
}

/** What clients see of a project's cache. */
export interface DepsSummary {
  readonly status: "none" | "building" | "ready" | "failed";
  /** When the running build started. */
  readonly buildStartedAt: string | null;
  readonly commit: string | null;
  readonly builtAt: string | null;
  readonly error: string | null;
}

/** R2 keys of a project's caches. */
export const depsPrefix = (repo: string) => `deps/${repo.toLowerCase()}/`;

/** A DirectoryBackup's object key (see DirectoryBackupRecord). */
export const depsObjectKey = (repo: string, backup: DirectoryBackupRecord) =>
  `${depsPrefix(repo)}${backup.id}.tar.zst`;

/**
 * Whether the default branch's lockfile (its hash, or null when it has none)
 * needs a new cache: none exists, the lockfile changed, or a sandbox reported
 * an image whose toolchain the cache does not fit.
 */
export function needsBuild(
  state: DepsState,
  input: { readonly lockfile: string | null; readonly toolchain?: string; readonly now: number },
): boolean {
  if (state.building && input.now - Date.parse(state.building.startedAt) < DEPS_BUILD_TIMEOUT_MS) {
    return false;
  }
  if (input.lockfile === null) return false;
  if (
    state.failed?.lockfile === input.lockfile &&
    input.now - Date.parse(state.failed.at) < DEPS_RETRY_FAILED_MS
  ) {
    return false;
  }
  if (!state.cache) return true;
  return (
    state.cache.lockfile !== input.lockfile ||
    (input.toolchain !== undefined && input.toolchain !== state.cache.toolchain)
  );
}

export function depsSummary(state: DepsState): DepsSummary {
  const status = state.building
    ? "building"
    : state.cache
      ? "ready"
      : state.failed
        ? "failed"
        : "none";
  return {
    status,
    buildStartedAt: state.building?.startedAt ?? null,
    commit: state.cache?.commit ?? null,
    builtAt: state.cache?.builtAt ?? null,
    error: state.failed?.error ?? null,
  };
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
