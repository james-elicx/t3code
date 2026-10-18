import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findSandboxForEnvironment,
  newSandboxId,
  SANDBOX_ID_PATTERN,
  sandboxRegistration,
  type SandboxEntry,
} from "./directory";

const entry = (overrides: Partial<SandboxEntry> = {}): SandboxEntry => ({
  threadId: "t-abc123",
  title: "acme/demo",
  status: "running",
  repo: "acme/demo",
  projectId: "sandbox:acme/demo",
  instance: "standard-2",
  environmentId: "env-1",
  lastError: null,
  ranAt: "2026-10-17T10:00:00.000Z",
  setupStep: null,
  pendingThread: null,
  httpBaseUrl: "https://control.example.workers.dev/s/t-abc123",
  wsBaseUrl: "wss://control.example.workers.dev/s/t-abc123/ws",
  ...overrides,
});

describe("sandboxRegistration", () => {
  it("connects to the sandbox's route under its environment id", () => {
    const registration = sandboxRegistration(entry());
    expect(registration?.target.environmentId).toBe("env-1");
    expect(registration?.profile.connectionId).toBe("sandbox:t-abc123");
    expect(registration?.profile.httpBaseUrl).toBe(
      "https://control.example.workers.dev/s/t-abc123",
    );
    expect(registration?.profile.wsBaseUrl).toBe("wss://control.example.workers.dev/s/t-abc123/ws");
    expect(registration?.target.label).toBe("acme/demo · t-abc123");
  });

  it("holds a placeholder rather than any sandbox credential", () => {
    expect(sandboxRegistration(entry())?.credential.token).toBe("sandbox-proxy");
  });

  it("skips a sandbox whose T3 server has not answered yet", () => {
    expect(sandboxRegistration(entry({ environmentId: null, status: "starting" }))).toBeNull();
  });

  it("lists a project's unstarted sandbox under its repository", () => {
    const registration = sandboxRegistration(entry({ status: "unstarted", ranAt: null }));
    expect(registration?.target.environmentId).toBe("env-1");
    expect(registration?.target.label).toBe("New sandbox · acme/demo");
  });

  it("keeps an asleep sandbox, so its threads stay listed from the cache", () => {
    expect(sandboxRegistration(entry({ status: "asleep" }))).not.toBeNull();
  });
});

describe("findSandboxForEnvironment", () => {
  it("tells sandbox environments apart from others", () => {
    const entries = [entry(), entry({ threadId: "t-other", environmentId: "env-2" })];
    expect(findSandboxForEnvironment(entries, EnvironmentId.make("env-2"))?.threadId).toBe(
      "t-other",
    );
    expect(findSandboxForEnvironment(entries, EnvironmentId.make("env-local"))).toBeNull();
  });
});

describe("newSandboxId", () => {
  it("is a DNS label the control plane accepts", () => {
    const id = newSandboxId();
    expect(SANDBOX_ID_PATTERN.test(id)).toBe(true);
    expect(newSandboxId()).not.toBe(id);
  });
});
