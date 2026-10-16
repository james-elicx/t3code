import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import type { SandboxSession } from "../session.ts";
import { ALLOWED_GRAPHQL_MUTATIONS, decideGraphql } from "./githubGraphql.ts";

const session: SandboxSession = {
  threadId: "abc",
  repo: { owner: "acme", name: "demo" },
  baseBranch: "main",
  branchPrefix: "t3/abc/",
  pullRequests: [{ number: 7, nodeId: "PR_seven" }],
};

const mutation = (name: (typeof ALLOWED_GRAPHQL_MUTATIONS)[number]["name"]) =>
  ALLOWED_GRAPHQL_MUTATIONS.find((entry) => entry.name === name)!.document;

describe("decideGraphql", () => {
  it("forwards queries with the read token", () => {
    expect(decideGraphql({ query: "query { viewer { login } }" }, session)).toEqual({
      kind: "forward",
      credential: "read",
    });
    // A keyword inside a string or comment is not an operation.
    expect(
      decideGraphql(
        { query: '# mutation\nquery { search(query: "mutation") { issueCount } }' },
        session,
      ),
    ).toEqual({ kind: "forward", credential: "read" });
  });

  it("allows T3's own mutations only against pull requests this sandbox opened", () => {
    expect(
      decideGraphql(
        {
          query: mutation("markPullRequestReadyForReview"),
          variables: { pullRequestId: "PR_seven" },
        },
        session,
      ),
    ).toEqual({ kind: "forward", credential: "write" });
    // Whitespace differences still match the exact document.
    expect(
      decideGraphql(
        {
          query: mutation("addComment").replace(/\s+/g, "  "),
          variables: { subjectId: "PR_seven", body: "Done" },
        },
        session,
      ),
    ).toEqual({ kind: "forward", credential: "write" });
    expect(
      decideGraphql(
        { query: mutation("closePullRequest"), variables: { pullRequestId: "PR_someone_else" } },
        session,
      ),
    ).toMatchObject({ kind: "deny" });
  });

  it("denies merges, unknown mutations, subscriptions, and batches", () => {
    for (const body of [
      {
        query:
          "mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }",
        variables: { input: { pullRequestId: "PR_seven" } },
      },
      {
        query:
          'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "PR_seven"}) { clientMutationId } }',
      },
      { query: "mutation { createRef(input: {}) { clientMutationId } }" },
      {
        query: `${mutation("closePullRequest")} mutation Other { deleteRef(input: {}) { clientMutationId } }`,
      },
      { query: "subscription { anything }" },
      [{ query: "query { viewer { login } }" }],
      { variables: {} },
    ]) {
      expect(decideGraphql(body, session), JSON.stringify(body)).toMatchObject({ kind: "deny" });
    }
  });
});

describe("allowlist drift", () => {
  it("still matches the mutations T3's GitHub client sends", () => {
    const source = NodeFS.readFileSync(
      new URL(
        "../../../../packages/source-control-github/src/server/GitHubPullRequestApi.ts",
        import.meta.url,
      ),
      "utf8",
    );
    for (const entry of ALLOWED_GRAPHQL_MUTATIONS) {
      expect(source, `${entry.name} changed upstream; update the allowlist`).toContain(
        `\`${entry.document}\``,
      );
    }
  });
});
