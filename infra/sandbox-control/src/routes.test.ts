import { describe, expect, it } from "vite-plus/test";

import { isLoopbackHost, parseSandboxPath } from "./routes.ts";

describe("parseSandboxPath", () => {
  it("strips the sandbox prefix to the path its T3 server sees", () => {
    expect(parseSandboxPath("/s/t-abc123/api/auth/session")).toEqual({
      id: "t-abc123",
      rest: "/api/auth/session",
    });
    expect(parseSandboxPath("/s/t-abc123/ws")).toEqual({ id: "t-abc123", rest: "/ws" });
    expect(parseSandboxPath("/s/t-abc123")).toEqual({ id: "t-abc123", rest: "/" });
  });

  it("leaves the API, the web client, and invalid ids alone", () => {
    expect(parseSandboxPath("/api/sandboxes")).toBeNull();
    expect(parseSandboxPath("/sandbox")).toBeNull();
    expect(parseSandboxPath("/s/")).toBeNull();
    expect(parseSandboxPath("/s/Not_A_Label/ws")).toBeNull();
  });
});

describe("isLoopbackHost", () => {
  it("serves local development only", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("t3-sandbox-control.acme.workers.dev")).toBe(false);
  });
});
