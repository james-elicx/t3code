import { describe, expect, it } from "vite-plus/test";

import {
  DEPS_BUILD_TIMEOUT_MS,
  DEPS_RETRY_FAILED_MS,
  needsBuild,
  type DepsCache,
  type DepsState,
} from "./depsCache.ts";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const cache: DepsCache = {
  backup: { id: "b1", dir: "/var/cache/t3-deps", size: 1, sha256: "x", format: "tar+zstd/1" },
  lockfile: "lock-a",
  toolchain: "node v24 pnpm 11.1.1 x86_64",
  commit: "c1",
  builtAt: "2026-10-18T11:00:00.000Z",
};
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("needsBuild", () => {
  it("builds the first cache, and again when the lockfile changes", () => {
    expect(needsBuild({}, { lockfile: "lock-a", now })).toBe(true);
    expect(needsBuild({ cache }, { lockfile: "lock-a", now })).toBe(false);
    expect(needsBuild({ cache }, { lockfile: "lock-b", now })).toBe(true);
  });

  it("builds nothing for a default branch without a pnpm lockfile", () => {
    expect(needsBuild({}, { lockfile: null, now })).toBe(false);
  });

  it("rebuilds when a sandbox's image has another toolchain", () => {
    expect(
      needsBuild({ cache }, { lockfile: "lock-a", toolchain: "node v26 pnpm 11.1.1 x86_64", now }),
    ).toBe(true);
    expect(needsBuild({ cache }, { lockfile: "lock-a", toolchain: cache.toolchain, now })).toBe(
      false,
    );
  });

  it("starts no second build while one runs, unless that one is lost", () => {
    const building = (startedAt: string): DepsState => ({ building: { id: "deps-1", startedAt } });
    expect(needsBuild(building(ago(60_000)), { lockfile: "lock-a", now })).toBe(false);
    expect(needsBuild(building(ago(DEPS_BUILD_TIMEOUT_MS + 1)), { lockfile: "lock-a", now })).toBe(
      true,
    );
  });

  it("waits before trying a lockfile whose build failed again", () => {
    const failed = (at: string): DepsState => ({
      cache,
      failed: { lockfile: "lock-b", at, error: "pnpm install failed" },
    });
    expect(needsBuild(failed(ago(60_000)), { lockfile: "lock-b", now })).toBe(false);
    expect(
      needsBuild(failed(ago(60_000)), { lockfile: "lock-b", toolchain: "node v26", now }),
    ).toBe(false);
    expect(needsBuild(failed(ago(DEPS_RETRY_FAILED_MS + 1)), { lockfile: "lock-b", now })).toBe(
      true,
    );
    // Another lockfile is worth a try at once.
    expect(needsBuild(failed(ago(60_000)), { lockfile: "lock-c", now })).toBe(true);
  });
});
