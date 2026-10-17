import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";
import { type SandboxEntry, useSandboxDirectoryStore } from "./directory";
import {
  cancelSandboxPreparation,
  prepareSandbox,
  useSandboxPreparationStore,
} from "./preparation";

const DRAFT = "draft-1" as DraftId;
const requests: Array<{ method: string; url: string }> = [];

const entry = (overrides: Partial<SandboxEntry>): SandboxEntry => ({
  threadId: "",
  title: "acme/demo",
  status: "starting",
  repo: "acme/demo",
  projectId: "sandbox:acme/demo",
  instance: "standard-1",
  environmentId: null,
  lastError: null,
  httpBaseUrl: "",
  wsBaseUrl: "",
  ...overrides,
});

const preparation = () => useSandboxPreparationStore.getState().byDraft[DRAFT];
const sandboxId = () => preparation()?.sandboxId ?? "";
/** The directory poll listing the sandbox being prepared. */
const listed = (overrides: Partial<SandboxEntry>) =>
  useSandboxDirectoryStore.setState({ entries: [entry({ threadId: sandboxId(), ...overrides })] });

beforeEach(() => {
  vi.stubEnv("VITE_SANDBOX_DIRECTORY_URL", "https://control.example/api/sandboxes");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url });
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json(entry({ threadId: "created" }), { status: 202 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  requests.length = 0;
  useSandboxPreparationStore.setState({ byDraft: {} });
  useSandboxDirectoryStore.setState({ entries: [] });
});

describe("prepareSandbox", () => {
  it("reports the sandbox booting, then its failure, and deletes it so a retry starts fresh", async () => {
    const done = prepareSandbox(DRAFT, { repo: "acme/demo", instance: "standard-1" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.method).toBe("POST");

    // Listed once the create returns and the preparation is watching the directory.
    await vi.waitFor(() => {
      listed({ status: "starting" });
      expect(preparation()).toMatchObject({ phase: "booting", status: "starting" });
    });

    const failedId = sandboxId();
    listed({ lastError: "clone failed" });
    await done;
    expect(preparation()).toMatchObject({ phase: "failed", error: "clone failed" });
    expect(requests.at(-1)).toEqual({
      method: "DELETE",
      url: `https://control.example/api/sandboxes/${failedId}`,
    });
  });

  it("stops waiting when cancelled and deletes the sandbox", async () => {
    const done = prepareSandbox(DRAFT, { repo: "acme/demo", instance: "standard-1" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const cancelledId = sandboxId();
    await cancelSandboxPreparation(DRAFT);
    await done;
    expect(preparation()).toBeUndefined();
    expect(requests.at(-1)).toEqual({
      method: "DELETE",
      url: `https://control.example/api/sandboxes/${cancelledId}`,
    });
  });

  it("deletes a sandbox whose create finishes after it was cancelled", async () => {
    let finishCreate = () => {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", url });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      await new Promise<void>((resolve) => (finishCreate = resolve));
      return Response.json(entry({ threadId: "created" }), { status: 202 });
    });
    const done = prepareSandbox(DRAFT, { repo: "acme/demo", instance: "standard-1" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const cancelledId = sandboxId();
    // The control plane may handle this delete before the create.
    await cancelSandboxPreparation(DRAFT);
    finishCreate();
    await done;
    expect(requests.map(({ method }) => method)).toEqual(["POST", "DELETE", "DELETE"]);
    expect(requests.at(-1)?.url).toBe(`https://control.example/api/sandboxes/${cancelledId}`);
  });
});
