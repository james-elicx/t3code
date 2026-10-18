import { ProviderInstanceId, repositoryGroupingKeyOf } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SandboxEntry, SandboxPendingThread } from "./directory";
import { seededSandboxShell, seedSignature } from "./seed";
import { sandboxSetupSnapshot } from "./setup";

const pendingThread: SandboxPendingThread = {
  threadId: "thread-1",
  title: "Fix the build",
  createdAt: "2026-10-17T10:00:00.000Z",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const sandbox = (overrides: Partial<SandboxEntry> = {}): SandboxEntry => ({
  threadId: "t-slot",
  title: "acme/Demo",
  status: "unstarted",
  repo: "acme/Demo",
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

describe("seededSandboxShell", () => {
  it("lists the repository's project before any sandbox runs, with no thread", () => {
    const shell = seededSandboxShell(sandbox(), null);
    expect(shell.projects.map((project) => [project.id, project.title])).toEqual([
      ["sandbox:acme/demo", "Demo"],
    ]);
    expect(shell.threads).toEqual([]);
  });

  it("groups with the same repository cloned on any machine", () => {
    const [project] = seededSandboxShell(sandbox(), null).projects;
    expect(project?.repositoryIdentity && repositoryGroupingKeyOf(project.repositoryIdentity)).toBe(
      "github.com/acme/demo",
    );
  });

  it("uses the project's config the control plane keeps", () => {
    const shell = seededSandboxShell(sandbox(), {
      repo: "acme/Demo",
      createdAt: "2026-10-01T00:00:00.000Z",
      config: { title: "Demo app", defaultModelSelection: null, scripts: [] },
    });
    expect(shell.projects[0]?.title).toBe("Demo app");
  });

  it("shows a started thread as preparing until its sandbox answers", () => {
    const [thread] = seededSandboxShell(
      sandbox({ status: "starting", pendingThread }),
      null,
    ).threads;
    expect(thread?.id).toBe("thread-1");
    expect(thread?.title).toBe("Fix the build");
    expect(thread?.activityRunStatus).toBe("preparing");
  });

  it("is rewritten only when what it shows changes", () => {
    const before = seedSignature(sandbox(), null);
    expect(seedSignature(sandbox({ setupStep: "clone" }), null)).toBe(before);
    expect(seedSignature(sandbox({ pendingThread }), null)).not.toBe(before);
  });
});

describe("sandboxSetupSnapshot", () => {
  const booting = (overrides: Partial<SandboxEntry>) =>
    sandbox({ status: "starting", pendingThread, ...overrides });
  const stages = (entry: SandboxEntry) =>
    sandboxSetupSnapshot(entry, "thread-1")?.stages.map((stage) => stage.status);

  it("is only for the thread that started the sandbox", () => {
    expect(sandboxSetupSnapshot(booting({}), "thread-2")).toBeNull();
    expect(sandboxSetupSnapshot(sandbox(), "thread-1")).toBeNull();
  });

  it("follows the boot step by step", () => {
    expect(stages(booting({ setupStep: "container" }))).toEqual(["running", "pending", "pending"]);
    expect(stages(booting({ setupStep: "clone" }))).toEqual(["done", "running", "pending"]);
    expect(stages(booting({ setupStep: "launch" }))).toEqual(["done", "done", "running"]);
  });

  it("fails on a boot error between retries", () => {
    const snapshot = sandboxSetupSnapshot(booting({ lastError: "clone failed" }), "thread-1");
    expect(snapshot?.phase).toBe("failed");
    expect(snapshot?.error).toBe("clone failed");
  });

  it("fails when the sandbox runs but could not launch the thread", () => {
    const snapshot = sandboxSetupSnapshot(
      booting({ status: "running", ranAt: "2026-10-17T10:01:00.000Z" }),
      "thread-1",
    );
    expect(snapshot?.phase).toBe("failed");
    expect(snapshot?.stages.map((stage) => stage.status)).toEqual(["done", "done", "failed"]);
  });
});
