import type { SandboxSession } from "../session.ts";

/**
 * GraphQL writes a sandbox may send, copied verbatim from T3's own pull request
 * client (packages/source-control-github/src/server/GitHubPullRequestApi.ts).
 * A drift test fails when that file stops containing one of these, so a T3
 * upgrade that rewords a mutation is caught here instead of being silently denied.
 *
 * Merge and auto-merge are deliberately absent: a sandbox never merges.
 */
export const ALLOWED_GRAPHQL_MUTATIONS = [
  {
    name: "markPullRequestReadyForReview",
    document: `mutation($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`,
    nodeIdVariable: "pullRequestId",
  },
  {
    name: "convertPullRequestToDraft",
    document: `mutation($pullRequestId: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`,
    nodeIdVariable: "pullRequestId",
  },
  {
    name: "closePullRequest",
    document: `mutation($pullRequestId: ID!) {
  closePullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`,
    nodeIdVariable: "pullRequestId",
  },
  {
    name: "reopenPullRequest",
    document: `mutation($pullRequestId: ID!) {
  reopenPullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`,
    nodeIdVariable: "pullRequestId",
  },
  {
    name: "disablePullRequestAutoMerge",
    document: `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`,
    nodeIdVariable: "pullRequestId",
  },
  {
    name: "updatePullRequestBranch",
    document: `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $updateMethod: PullRequestBranchUpdateMethod!) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, updateMethod: $updateMethod }) { clientMutationId }
}`,
    nodeIdVariable: "pullRequestId",
  },
  {
    name: "addComment",
    document: `mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
}`,
    nodeIdVariable: "subjectId",
  },
] as const;

const normalize = (document: string) => document.replace(/\s+/g, " ").trim();
const allowedByDocument = new Map(
  ALLOWED_GRAPHQL_MUTATIONS.map((mutation) => [normalize(mutation.document), mutation]),
);

/** Drops comments and string literals so keywords inside them do not count. */
const stripNoise = (document: string) =>
  document
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, "");

export type GraphqlDecision =
  | { readonly kind: "forward"; readonly credential: "read" | "write" }
  | { readonly kind: "deny"; readonly reason: string };

export function decideGraphql(body: unknown, session: SandboxSession): GraphqlDecision {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "deny", reason: "GraphQL requests must be a single JSON object." };
  }
  const { query, variables } = body as { query?: unknown; variables?: unknown };
  if (typeof query !== "string") {
    return { kind: "deny", reason: "GraphQL requests need a query string." };
  }
  const code = stripNoise(query);
  if (/\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/.test(code)) {
    return { kind: "deny", reason: "Merging is never allowed from a sandbox." };
  }
  if (!/\b(mutation|subscription)\b/.test(code)) return { kind: "forward", credential: "read" };

  const allowed = allowedByDocument.get(normalize(query));
  if (!allowed) {
    return {
      kind: "deny",
      reason: "This GraphQL mutation is not on the sandbox allowlist.",
    };
  }
  const nodeId =
    typeof variables === "object" && variables !== null
      ? (variables as Record<string, unknown>)[allowed.nodeIdVariable]
      : undefined;
  if (!session.pullRequests.some((pullRequest) => pullRequest.nodeId === nodeId)) {
    return {
      kind: "deny",
      reason: `${allowed.name} may only target pull requests this sandbox opened.`,
    };
  }
  return { kind: "forward", credential: "write" };
}
