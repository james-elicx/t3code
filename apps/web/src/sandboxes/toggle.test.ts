import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";
import {
  resolveSandboxToggle,
  sandboxInstanceToStart,
  sandboxRepoOf,
  selectSandboxChoice,
} from "./toggle";

const identity = (overrides: Partial<RepositoryIdentity> = {}): RepositoryIdentity => ({
  canonicalKey: "github.com/acme/demo",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/demo" },
  ...overrides,
});

const draft = { isDraft: true, sandboxRepo: null, sandboxHasThread: false } as const;

describe("sandboxRepoOf", () => {
  it("names the GitHub repository a checkout pushes to", () => {
    expect(sandboxRepoOf(identity())).toBe("acme/demo");
  });

  it("uses a fork's own remote, which is where its sandbox may push", () => {
    expect(sandboxRepoOf(identity({ origin: { canonicalKey: "github.com/me/demo-fork" } }))).toBe(
      "me/demo-fork",
    );
  });

  it("has nothing for repositories off GitHub or without a remote", () => {
    expect(sandboxRepoOf(identity({ canonicalKey: "gitlab.com/acme/demo" }))).toBeNull();
    expect(sandboxRepoOf(null)).toBeNull();
  });
});

describe("resolveSandboxToggle", () => {
  it("offers a sandbox for a draft in a GitHub project on a machine", () => {
    expect(resolveSandboxToggle({ ...draft, repositoryIdentity: identity() })).toEqual({
      kind: "choose",
      repo: "acme/demo",
    });
  });

  it("explains why a project without a GitHub remote can't use one", () => {
    expect(resolveSandboxToggle({ ...draft, repositoryIdentity: null }).kind).toBe("unavailable");
  });

  it("sends straight into an empty sandbox: the draft is its one thread", () => {
    expect(
      resolveSandboxToggle({ ...draft, sandboxRepo: "acme/demo", repositoryIdentity: identity() }),
    ).toEqual({ kind: "hidden" });
  });

  it("starts another sandbox from a sandbox that already has its thread", () => {
    expect(
      resolveSandboxToggle({
        ...draft,
        sandboxRepo: "acme/demo",
        sandboxHasThread: true,
        repositoryIdentity: identity(),
      }),
    ).toEqual({ kind: "locked", repo: "acme/demo" });
  });

  it("is not offered once the thread has started", () => {
    expect(
      resolveSandboxToggle({ ...draft, isDraft: false, repositoryIdentity: identity() }).kind,
    ).toBe("hidden");
  });
});

describe("sandboxInstanceToStart", () => {
  it("follows the choice where there is one to make", () => {
    const toggle = { kind: "choose", repo: "acme/demo" } as const;
    expect(sandboxInstanceToStart(toggle, "standard-1")).toBe("standard-1");
    expect(sandboxInstanceToStart(toggle, null)).toBeNull();
  });

  it("always starts one from an occupied sandbox, and never otherwise", () => {
    expect(sandboxInstanceToStart({ kind: "locked", repo: "acme/demo" }, null)).toBe("standard-1");
    expect(sandboxInstanceToStart({ kind: "hidden" }, "standard-1")).toBeNull();
    expect(sandboxInstanceToStart({ kind: "unavailable", reason: "" }, "standard-1")).toBeNull();
  });
});

describe("selectSandboxChoice", () => {
  it("defaults a new draft to the last choice, and keeps each draft's own", () => {
    const state = { byDraft: { ["d-1" as DraftId]: null }, last: "standard-1" as const };
    expect(selectSandboxChoice(state, "d-1" as DraftId)).toBeNull();
    expect(selectSandboxChoice(state, "d-2" as DraftId)).toBe("standard-1");
  });
});
