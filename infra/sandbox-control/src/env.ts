import type { SandboxDirectory } from "./SandboxDirectory.ts";
import type { ThreadSandbox } from "./ThreadSandbox.ts";

export interface Env {
  readonly THREAD_SANDBOX: DurableObjectNamespace<ThreadSandbox>;
  readonly SANDBOX_DIRECTORY: DurableObjectNamespace<SandboxDirectory>;
  readonly ASSETS: Fetcher;

  /** Sandboxes are served at `<thread-id>.<SANDBOX_DOMAIN>`. */
  readonly SANDBOX_DOMAIN: string;
  /** `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`; a local mock in dev. */
  readonly AI_GATEWAY_BASE_URL: string;
  readonly AI_GATEWAY_TOKEN: string;
  readonly GITHUB_WRITE_PAT: string;
  readonly GITHUB_READ_PAT: string;
  /** Upstreams for github.com and api.github.com; overridden by a local mock in dev. */
  readonly GITHUB_ORIGIN: string;
  readonly GITHUB_API_ORIGIN: string;
  /** Comma-separated hosts a sandbox may reach anonymously, e.g. `registry.npmjs.org`. */
  readonly PUBLIC_EGRESS_HOSTS: string;
  /** `"1"` enables `POST /api/sandboxes/:id/exec`, which local proofs use. Never in production. */
  readonly DEBUG_EXEC: string;
}

export interface EgressProps {
  readonly threadId: string;
}

/** `ctx.exports` is typed by `wrangler types`; this package declares just what it uses. */
export interface ControlPlaneExports {
  Egress(options: { props: EgressProps }): Fetcher;
}
