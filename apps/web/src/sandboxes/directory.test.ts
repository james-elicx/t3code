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
  environmentId: "env-1",
  lastError: null,
  httpBaseUrl: "https://t-abc123.sandbox.example.com",
  wsBaseUrl: "wss://t-abc123.sandbox.example.com",
  ...overrides,
});

describe("sandboxRegistration", () => {
  it("connects to the sandbox's own origin under its environment id", () => {
    const registration = sandboxRegistration(entry());
    expect(registration?.target.environmentId).toBe("env-1");
    expect(registration?.profile.connectionId).toBe("sandbox:t-abc123");
    expect(registration?.profile.httpBaseUrl).toBe("https://t-abc123.sandbox.example.com");
    expect(registration?.profile.wsBaseUrl).toBe("wss://t-abc123.sandbox.example.com");
    expect(registration?.target.label).toBe("acme/demo · t-abc123");
  });

  it("holds a placeholder rather than any sandbox credential", () => {
    expect(sandboxRegistration(entry())?.credential.token).toBe("sandbox-proxy");
  });

  it("skips a sandbox whose T3 server has not answered yet", () => {
    expect(sandboxRegistration(entry({ environmentId: null, status: "starting" }))).toBeNull();
  });

  it("keeps a stopped sandbox, which wakes when the app connects", () => {
    expect(sandboxRegistration(entry({ status: "stopped" }))).not.toBeNull();
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
