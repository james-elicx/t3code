import { EnvironmentId, ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SandboxEntry } from "./directory";
import { resolveSandboxToggle, sandboxDraftTarget, sandboxRepoOf } from "./toggle";

const identity = (overrides: Partial<RepositoryIdentity> = {}): RepositoryIdentity => ({
  canonicalKey: "github.com/acme/demo",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/demo" },
  ...overrides,
});

const sandbox = (overrides: Partial<SandboxEntry> = {}): SandboxEntry => ({
  threadId: "t-slot",
  title: "acme/demo",
  status: "unstarted",
  repo: "acme/demo",
  projectId: "sandbox:acme/demo",
  instance: "standard-2",
  environmentId: "env-slot",
  lastError: null,
  ranAt: null,
  setupStep: null,
  pendingThread: null,
  httpBaseUrl: "https://control.example/s/t-slot",
  wsBaseUrl: "wss://control.example/s/t-slot/ws",
  ...overrides,
});

const machineProject = {
  environmentId: EnvironmentId.make("env-laptop"),
  id: ProjectId.make("p-laptop"),
  repositoryIdentity: identity(),
};
const slotProject = {
  environmentId: EnvironmentId.make("env-slot"),
  id: ProjectId.make("sandbox:acme/demo"),
  repositoryIdentity: identity(),
};

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
  const projects = [machineProject, slotProject];

  it("moves a draft on your machine to the project's unstarted sandbox", () => {
    expect(
      resolveSandboxToggle({
        isDraft: true,
        project: machineProject,
        entries: [sandbox()],
        projects,
      }),
    ).toEqual({
      kind: "choose",
      repo: "acme/demo",
      on: false,
      sandboxProjectRef: { environmentId: "env-slot", projectId: "sandbox:acme/demo" },
      machineProjectRef: { environmentId: "env-laptop", projectId: "p-laptop" },
    });
  });

  it("is on for a draft in a sandbox, and can move it back to your machine", () => {
    const toggle = resolveSandboxToggle({
      isDraft: true,
      project: slotProject,
      entries: [sandbox()],
      projects,
    });
    expect(toggle.kind === "choose" && toggle.on).toBe(true);
    expect(toggle.kind === "choose" && toggle.machineProjectRef?.environmentId).toBe("env-laptop");
  });

  it("has no sandbox to move to until the control plane keeps the repository", () => {
    const toggle = resolveSandboxToggle({
      isDraft: true,
      project: machineProject,
      entries: [],
      projects: [machineProject],
    });
    expect(toggle.kind === "choose" && toggle.sandboxProjectRef).toBeNull();
  });

  it("never offers a running sandbox as the place for a new thread", () => {
    const toggle = resolveSandboxToggle({
      isDraft: true,
      project: machineProject,
      entries: [sandbox({ status: "running", environmentId: "env-busy" })],
      projects,
    });
    expect(toggle.kind === "choose" && toggle.sandboxProjectRef).toBeNull();
  });

  it("explains why a project without a GitHub remote can't use one", () => {
    const project = { ...machineProject, repositoryIdentity: null };
    expect(resolveSandboxToggle({ isDraft: true, project, entries: [], projects }).kind).toBe(
      "unavailable",
    );
  });

  it("is not offered once the thread has started", () => {
    expect(
      resolveSandboxToggle({ isDraft: false, project: slotProject, entries: [sandbox()], projects })
        .kind,
    ).toBe("hidden");
  });
});

describe("sandboxDraftTarget", () => {
  const toggle = resolveSandboxToggle({
    isDraft: true,
    project: slotProject,
    entries: [sandbox()],
    projects: [slotProject],
  });

  it("moves a draft out of a sandbox that already holds a thread", () => {
    expect(sandboxDraftTarget(toggle, true)?.environmentId).toBe("env-slot");
  });

  it("leaves a draft that is its sandbox's one thread where it is", () => {
    expect(sandboxDraftTarget(toggle, false)).toBeNull();
  });
});
