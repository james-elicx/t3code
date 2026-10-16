import type { SandboxDirectory } from "./SandboxDirectory.ts";
import type { ThreadSandbox } from "./ThreadSandbox.ts";

export interface Env {
  readonly ASSETS: Fetcher;

  /**
   * Cloudflare Access: `https://<team>.cloudflareaccess.com` and the
   * application's AUD tag. Unset only in local development, where the Worker
   * serves loopback hosts alone.
   */
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  /** `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`; a local mock in dev. */
  readonly AI_GATEWAY_BASE_URL: string;
  readonly AI_GATEWAY_TOKEN: string;
  readonly GITHUB_WRITE_PAT: string;
  /** Optional: without it, the session repository is fetched anonymously, so it must be public. */
  readonly GITHUB_READ_PAT?: string;
  /** Upstreams for github.com and api.github.com; overridden by a local mock in dev. */
  readonly GITHUB_ORIGIN: string;
  readonly GITHUB_API_ORIGIN: string;
  /** `"1"` enables `POST /api/sandboxes/:id/exec`, which local proofs use. Never in production. */
  readonly DEBUG_EXEC: string;
}

export interface EgressProps {
  readonly threadId: string;
}

/**
 * This Worker's own classes, through `ctx.exports` rather than bindings: a
 * Container may only attach to a Durable Object that no binding names a
 * `script_name` for, and `cf` writes one on every binding.
 */
export interface ControlPlaneExports {
  readonly ThreadSandbox: DurableObjectNamespace<ThreadSandbox>;
  readonly SandboxDirectory: DurableObjectNamespace<SandboxDirectory>;
  Egress(options: { props: EgressProps }): Fetcher;
}

export const controlPlane = (ctx: { readonly exports: unknown }) =>
  ctx.exports as ControlPlaneExports;
