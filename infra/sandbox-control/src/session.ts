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

/**
 * The checkout's project in every sandbox for a repo. The control plane creates
 * it, so clients can find it, and project-scoped settings carry across sandboxes.
 */
export const sandboxProjectId = (repo: { readonly owner: string; readonly name: string }) =>
  `sandbox:${repo.owner}/${repo.name}`.toLowerCase();

/** DNS-label-shaped ids: one path segment, `/s/<id>`, and safe in branch names. */
export const SANDBOX_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isSessionRepo = (session: SandboxSession, owner: string, name: string) =>
  owner.toLowerCase() === session.repo.owner.toLowerCase() &&
  name.replace(/\.git$/i, "").toLowerCase() === session.repo.name.toLowerCase();

export const isSessionBranch = (session: SandboxSession, branch: string) =>
  branch.startsWith(session.branchPrefix) &&
  branch.length > session.branchPrefix.length &&
  branch !== session.baseBranch;
