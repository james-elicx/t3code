import { describe, expect, it } from "vitest";

import { launchRequest, parseLaunch, parseRepo, projectConfigOf } from "./projects.ts";

const launch = {
  commandId: "command-1",
  threadId: "thread-1",
  title: "Fix the build",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-10-17T10:00:00.000Z",
  initialMessage: { messageId: "message-1", text: "Fix the build" },
};

describe("parseLaunch", () => {
  it("keeps a client's launch", () => {
    expect(parseLaunch(launch)).toEqual(launch);
  });

  it("names what a launch is missing", () => {
    expect(parseLaunch({ ...launch, threadId: "" })).toBe("launch.threadId is required.");
    expect(parseLaunch({ ...launch, modelSelection: null })).toBe(
      "launch.modelSelection is required.",
    );
    expect(parseLaunch({ ...launch, initialMessage: { text: "hi" } })).toBe(
      "launch.initialMessage needs a messageId and text.",
    );
  });
});

describe("launchRequest", () => {
  it("starts the thread in the sandbox's checkout with the client's ids", () => {
    const parsed = parseLaunch(launch);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(launchRequest(parsed, "sandbox:acme/demo")).toMatchObject({
      commandId: "command-1",
      threadId: "thread-1",
      projectId: "sandbox:acme/demo",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: "message-1", text: "Fix the build", attachments: [] },
    });
  });
});

describe("projects", () => {
  it("parses owner/name", () => {
    expect(parseRepo(" acme/demo.git ")).toEqual({ owner: "acme", name: "demo" });
    expect(() => parseRepo("acme")).toThrow();
  });

  it("reads the editable config from T3's shell project", () => {
    expect(projectConfigOf({ title: "demo" })).toEqual({
      title: "demo",
      defaultModelSelection: null,
      scripts: [],
    });
  });
});
