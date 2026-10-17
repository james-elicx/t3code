import type { DirectoryBackupGatewayBinding, S3GatewayBinding } from "@cloudflare/sandbox";

import type { SandboxDirectory } from "./SandboxDirectory.ts";
import type { ThreadSandbox } from "./ThreadSandbox.ts";

export interface Env {
  readonly ASSETS: Fetcher;
  /** Each sandbox's T3 home, saved when it sleeps and at checkpoints. */
  readonly BACKUPS: R2Bucket;

  // Secrets, from `.dev.vars` locally and the secrets file when deployed.

  /**
   * Cloudflare Access: `https://<team>.cloudflareaccess.com` and the
   * application's AUD tag. Unset only in local development, where the Worker
   * serves loopback hosts alone.
   */
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  /** The gateway's endpoint as the dashboard shows it (see `aiGatewayBaseUrl`); a mock locally. */
  readonly AI_GATEWAY_URL?: string;
  readonly AI_GATEWAY_TOKEN: string;
  readonly GITHUB_WRITE_PAT: string;
  /** Optional: without it, the session repository is fetched anonymously, so it must be public. */
  readonly GITHUB_READ_PAT?: string;
  /** Upstreams for github.com and api.github.com; overridden by a local mock in dev. */
  readonly GITHUB_ORIGIN: string;
  readonly GITHUB_API_ORIGIN: string;
  /** `"1"` enables `POST /api/sandboxes/:id/exec`, which local proofs use. Never in production. */
  readonly DEBUG_EXEC: string;
  /** How long a settled sandbox stays awake after its last view, in ms. */
  readonly SLEEP_AFTER_MS: string;
  /** How often an awake sandbox's lifecycle alarm runs, in ms. */
  readonly LIFECYCLE_TICK_MS: string;
  /**
   * The bucket every sandbox mounts read-only at /shared (skills and memories),
   * through R2's S3 API; without all three there is no mount. The keys stay in the Worker,
   * which signs each request.
   */
  readonly SHARED_S3_ENDPOINT?: string;
  readonly SHARED_S3_ACCESS_KEY_ID?: string;
  readonly SHARED_S3_SECRET_ACCESS_KEY?: string;
  readonly SHARED_S3_REGION: string;
  readonly SHARED_BUCKET: string;
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
  readonly DirectoryBackupGateway: DirectoryBackupGatewayBinding;
  readonly S3Gateway: S3GatewayBinding;
  Egress(options: { props: EgressProps }): Fetcher;
}

export const controlPlane = (ctx: { readonly exports: unknown }) =>
  ctx.exports as ControlPlaneExports;
