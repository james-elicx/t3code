import { isSessionBranch, isSessionRepo, type SandboxSession } from "../session.ts";
import type { RefUpdate } from "./pktLine.ts";

/**
 * Which PAT, if any, a GitHub request from a sandbox is forwarded with.
 * `write` and `read` are separate fine-grained tokens held only by the Worker;
 * `none` forwards the request anonymously.
 */
export type Credential = "write" | "read" | "none";

/** Checks that need the request body before the request may be forwarded. */
export type BodyCheck = "receive-pack" | "create-pull-request" | "update-pull-request" | "graphql";

export type GitHubDecision =
  | { readonly kind: "forward"; readonly credential: Credential; readonly check?: BodyCheck }
  | { readonly kind: "deny"; readonly reason: string };

export interface GitHubRequest {
  readonly method: string;
  readonly host: string;
  readonly pathname: string;
  readonly search: string;
}

const READS = new Set(["GET", "HEAD"]);
const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/;
/** Account-level reads that tools such as `gh auth status` need; they expose no repository data. */
const IDENTITY_READS = new Set(["/user", "/rate_limit"]);

const deny = (reason: string): GitHubDecision => ({ kind: "deny", reason });
const forward = (credential: Credential, check?: BodyCheck): GitHubDecision =>
  check ? { kind: "forward", credential, check } : { kind: "forward", credential };

const recordedPullRequest = (session: SandboxSession, number: string | undefined) =>
  number !== undefined && session.pullRequests.some((pr) => String(pr.number) === number);

export function decideGitHubRequest(
  request: GitHubRequest,
  session: SandboxSession,
): GitHubDecision {
  const method = request.method.toUpperCase();
  if (request.host === "github.com") return decideGit(method, request, session);
  if (request.host === "api.github.com") return decideApi(method, request, session);
  return deny(`${request.host} is not a GitHub host this policy handles.`);
}

function decideGit(method: string, request: GitHubRequest, session: SandboxSession) {
  const match = GIT_PATH.exec(request.pathname);
  if (!match) {
    return READS.has(method)
      ? forward("none")
      : deny("Only git fetches and pushes to the session repository are allowed on github.com.");
  }
  const [, owner, name, endpoint] = match as unknown as [string, string, string, string];
  const own = isSessionRepo(session, owner, name);
  const service = new URLSearchParams(request.search).get("service");

  if (endpoint === "info/refs" && method === "GET") {
    if (service === "git-upload-pack") return forward(own ? "read" : "none");
    if (service === "git-receive-pack") {
      return own ? forward("write") : deny(`Pushing to ${owner}/${name} is not allowed.`);
    }
    return deny("Only the smart HTTP git protocol is supported.");
  }
  if (endpoint === "git-upload-pack" && method === "POST") return forward(own ? "read" : "none");
  if (endpoint === "git-receive-pack" && method === "POST") {
    return own
      ? forward("write", "receive-pack")
      : deny(`Pushing to ${owner}/${name} is not allowed.`);
  }
  return deny(`${method} ${request.pathname} is not a git request a sandbox may send.`);
}

function decideApi(method: string, request: GitHubRequest, session: SandboxSession) {
  if (request.pathname === "/graphql") {
    return method === "POST" ? forward("read", "graphql") : deny("GraphQL takes POST requests.");
  }
  const match = REPO_PATH.exec(request.pathname);
  if (!match) {
    if (!READS.has(method)) return deny("Writes outside the session repository are not allowed.");
    return forward(IDENTITY_READS.has(request.pathname) ? "read" : "none");
  }
  const [, owner, name, rest = ""] = match as unknown as [string, string, string, string?];
  const own = isSessionRepo(session, owner, name);
  if (READS.has(method)) return forward(own ? "read" : "none");
  if (!own) return deny(`Writes to ${owner}/${name} are not allowed from this sandbox.`);

  if (/^\/pulls\/\d+\/merge$/.test(rest) || rest === "/merges") {
    return deny("Merging is never allowed from a sandbox.");
  }
  if (rest === "/pulls" && method === "POST") return forward("write", "create-pull-request");

  const pull = /^\/(?:pulls|issues)\/(\d+)(\/.*)?$/.exec(rest);
  if (pull) {
    const [, number, sub = ""] = pull;
    if (!recordedPullRequest(session, number)) {
      return deny(`Pull request #${number} was not opened by this sandbox.`);
    }
    if (rest.startsWith("/pulls/") && sub === "" && method === "PATCH") {
      return forward("write", "update-pull-request");
    }
    const allowed =
      (method === "POST" && ["/comments", "/reviews", "/requested_reviewers"].includes(sub)) ||
      (method === "DELETE" && sub === "/requested_reviewers") ||
      (method === "PUT" && sub === "/update-branch" && rest.startsWith("/pulls/"));
    if (allowed) return forward("write");
  }
  return deny(`${method} ${request.pathname} is not a write a sandbox may make.`);
}

/** Each ref the push may not update, with the reason. Empty when every ref is the session's own branch. */
export function refusedRefUpdates(
  updates: ReadonlyArray<RefUpdate>,
  session: SandboxSession,
): Map<string, string> {
  const refused = new Map<string, string>();
  for (const update of updates) {
    if (!update.ref.startsWith("refs/heads/")) {
      refused.set(
        update.ref,
        `T3 sandbox policy: only branches under refs/heads/${session.branchPrefix} may be pushed`,
      );
      continue;
    }
    const branch = update.ref.slice("refs/heads/".length);
    if (!isSessionBranch(session, branch)) {
      refused.set(
        update.ref,
        `T3 sandbox policy: ${branch} is outside this sandbox's branches (${session.branchPrefix}*)`,
      );
    }
  }
  return refused;
}

/** `head` may be `branch` or `owner:branch`, as the REST API accepts both. */
export function checkCreatePullRequest(body: unknown, session: SandboxSession): string | null {
  if (typeof body !== "object" || body === null) return "The pull request body must be JSON.";
  const { head, base } = body as { head?: unknown; base?: unknown };
  if (typeof head !== "string" || typeof base !== "string") {
    return "A pull request needs head and base.";
  }
  const colon = head.indexOf(":");
  const headOwner = colon === -1 ? session.repo.owner : head.slice(0, colon);
  const headBranch = colon === -1 ? head : head.slice(colon + 1);
  if (headOwner.toLowerCase() !== session.repo.owner.toLowerCase()) {
    return "Pull requests must come from the session repository.";
  }
  if (!isSessionBranch(session, headBranch)) {
    return `The head branch must be under ${session.branchPrefix}.`;
  }
  if (base !== session.baseBranch) return `Pull requests must target ${session.baseBranch}.`;
  return null;
}

export function checkUpdatePullRequest(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "The pull request body must be JSON.";
  if ("base" in body) return "Changing a pull request's base is not allowed from a sandbox.";
  return null;
}

/**
 * The `Authorization` header a GitHub request is forwarded with, or null to send
 * it anonymously. An unset PAT means anonymous: public repositories still clone
 * without a read PAT, where a bad credential would get a 401.
 */
export function githubAuthorization(host: string, token: string | undefined): string | null {
  if (!token) return null;
  // git uses Basic auth over smart HTTP; the REST and GraphQL APIs take a bearer token.
  return host === "github.com" ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`;
}
