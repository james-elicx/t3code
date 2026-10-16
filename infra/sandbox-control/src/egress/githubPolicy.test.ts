import { describe, expect, it } from "vite-plus/test";

import type { SandboxSession } from "../session.ts";
import {
  checkCreatePullRequest,
  checkUpdatePullRequest,
  decideGitHubRequest,
  githubAuthorization,
  refusedRefUpdates,
} from "./githubPolicy.ts";

const session: SandboxSession = {
  threadId: "abc",
  repo: { owner: "acme", name: "demo" },
  baseBranch: "main",
  branchPrefix: "t3/abc/",
  pullRequests: [{ number: 7, nodeId: "PR_seven" }],
};

const decide = (method: string, url: string) => {
  const parsed = new URL(url);
  return decideGitHubRequest(
    { method, host: parsed.hostname, pathname: parsed.pathname, search: parsed.search },
    session,
  );
};

describe("git smart HTTP", () => {
  it("fetches the session repo with the read token and other repos anonymously", () => {
    expect(
      decide("GET", "https://github.com/acme/demo.git/info/refs?service=git-upload-pack"),
    ).toEqual({ kind: "forward", credential: "read" });
    expect(decide("POST", "https://github.com/acme/demo/git-upload-pack")).toEqual({
      kind: "forward",
      credential: "read",
    });
    expect(decide("POST", "https://github.com/other/lib.git/git-upload-pack")).toEqual({
      kind: "forward",
      credential: "none",
    });
  });

  it("pushes only to the session repo, and inspects the ref updates first", () => {
    expect(
      decide("GET", "https://github.com/acme/demo.git/info/refs?service=git-receive-pack"),
    ).toEqual({ kind: "forward", credential: "write" });
    expect(decide("POST", "https://github.com/ACME/Demo.git/git-receive-pack")).toEqual({
      kind: "forward",
      credential: "write",
      check: "receive-pack",
    });
    expect(decide("POST", "https://github.com/other/lib.git/git-receive-pack").kind).toBe("deny");
    expect(
      decide("GET", "https://github.com/other/lib.git/info/refs?service=git-receive-pack").kind,
    ).toBe("deny");
  });

  it("refuses every ref outside the session prefix, including tags and the base branch", () => {
    const update = (ref: string) => ({ oldOid: "0".repeat(40), newOid: "a".repeat(40), ref });
    expect(
      refusedRefUpdates(
        [update("refs/heads/t3/abc/work"), update("refs/heads/t3/abc/x/y")],
        session,
      ),
    ).toEqual(new Map());
    const refused = refusedRefUpdates(
      [
        update("refs/heads/main"),
        update("refs/tags/v1"),
        update("refs/heads/t3/other/work"),
        update("refs/heads/t3/abc/"),
        update("refs/heads/t3/abc"),
        update("refs/heads/t3/abc/ok"),
      ],
      session,
    );
    expect([...refused.keys()]).toEqual([
      "refs/heads/main",
      "refs/tags/v1",
      "refs/heads/t3/other/work",
      "refs/heads/t3/abc/",
      "refs/heads/t3/abc",
    ]);
  });
});

describe("REST API", () => {
  it("reads the session repo with the read token and everything else anonymously", () => {
    expect(decide("GET", "https://api.github.com/repos/acme/demo/pulls/7")).toEqual({
      kind: "forward",
      credential: "read",
    });
    expect(decide("GET", "https://api.github.com/repos/other/lib")).toEqual({
      kind: "forward",
      credential: "none",
    });
    expect(decide("GET", "https://api.github.com/user")).toEqual({
      kind: "forward",
      credential: "read",
    });
    expect(decide("GET", "https://api.github.com/orgs/acme/repos")).toEqual({
      kind: "forward",
      credential: "none",
    });
  });

  it("opens pull requests only after checking head and base", () => {
    expect(decide("POST", "https://api.github.com/repos/acme/demo/pulls")).toEqual({
      kind: "forward",
      credential: "write",
      check: "create-pull-request",
    });
    expect(checkCreatePullRequest({ head: "t3/abc/work", base: "main" }, session)).toBeNull();
    expect(checkCreatePullRequest({ head: "acme:t3/abc/work", base: "main" }, session)).toBeNull();
    expect(checkCreatePullRequest({ head: "t3/abc/work", base: "release" }, session)).toMatch(
      /main/,
    );
    expect(checkCreatePullRequest({ head: "feature", base: "main" }, session)).toMatch(/t3\/abc\//);
    expect(checkCreatePullRequest({ head: "fork:t3/abc/work", base: "main" }, session)).toMatch(
      /session repository/,
    );
    expect(checkCreatePullRequest({ head: "main", base: "main" }, session)).not.toBeNull();
  });

  it("edits and comments only on pull requests this sandbox opened, never changing base", () => {
    expect(decide("PATCH", "https://api.github.com/repos/acme/demo/pulls/7")).toEqual({
      kind: "forward",
      credential: "write",
      check: "update-pull-request",
    });
    expect(checkUpdatePullRequest({ title: "Better title", body: "…" })).toBeNull();
    expect(checkUpdatePullRequest({ base: "release" })).toMatch(/base/);
    expect(decide("POST", "https://api.github.com/repos/acme/demo/issues/7/comments")).toEqual({
      kind: "forward",
      credential: "write",
    });
    expect(decide("POST", "https://api.github.com/repos/acme/demo/pulls/7/reviews")).toEqual({
      kind: "forward",
      credential: "write",
    });
    expect(decide("PATCH", "https://api.github.com/repos/acme/demo/pulls/8").kind).toBe("deny");
    expect(decide("POST", "https://api.github.com/repos/acme/demo/issues/8/comments").kind).toBe(
      "deny",
    );
  });

  it("always denies merges and any other write", () => {
    for (const [method, url] of [
      ["PUT", "https://api.github.com/repos/acme/demo/pulls/7/merge"],
      ["POST", "https://api.github.com/repos/acme/demo/merges"],
      ["DELETE", "https://api.github.com/repos/acme/demo"],
      ["PUT", "https://api.github.com/repos/acme/demo/contents/README.md"],
      ["POST", "https://api.github.com/repos/acme/demo/git/refs"],
      ["POST", "https://api.github.com/repos/other/lib/pulls"],
      ["POST", "https://api.github.com/user/repos"],
    ] as const) {
      expect(decide(method, url), `${method} ${url}`).toMatchObject({ kind: "deny" });
    }
    expect(decide("PUT", "https://api.github.com/repos/acme/demo/pulls/7/merge")).toMatchObject({
      reason: expect.stringMatching(/Merging/),
    });
  });
});

describe("githubAuthorization", () => {
  it("uses Basic auth for git and a bearer token for the API", () => {
    expect(githubAuthorization("github.com", "pat")).toBe(`Basic ${btoa("x-access-token:pat")}`);
    expect(githubAuthorization("api.github.com", "pat")).toBe("Bearer pat");
  });

  it("goes anonymous without a PAT, so public repositories still clone", () => {
    expect(githubAuthorization("github.com", undefined)).toBeNull();
    expect(githubAuthorization("github.com", "")).toBeNull();
  });
});
