/**
 * What a sandbox may do on GitHub. The ThreadSandbox Durable Object owns it; the
 * egress entrypoint reads it on every request, so recorded pull requests take
 * effect immediately.
 */
export interface SandboxSession {
  readonly threadId: string;
  readonly repo: { readonly owner: string; readonly name: string };
  /** The branch pull requests must target, e.g. `main`. Never writable. */
  readonly baseBranch: string;
  /** Branch names this session may push, e.g. `t3/<thread-id>/`. */
  readonly branchPrefix: string;
  readonly pullRequests: ReadonlyArray<RecordedPullRequest>;
}

export interface RecordedPullRequest {
  readonly number: number;
  readonly nodeId: string;
}

export const sessionBranchPrefix = (threadId: string) => `t3/${threadId}/`;

/** DNS-label-shaped ids, so a thread id is always a valid `<id>.<domain>` hostname. */
export const SANDBOX_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isSessionRepo = (session: SandboxSession, owner: string, name: string) =>
  owner.toLowerCase() === session.repo.owner.toLowerCase() &&
  name.replace(/\.git$/i, "").toLowerCase() === session.repo.name.toLowerCase();

export const isSessionBranch = (session: SandboxSession, branch: string) =>
  branch.startsWith(session.branchPrefix) &&
  branch.length > session.branchPrefix.length &&
  branch !== session.baseBranch;
