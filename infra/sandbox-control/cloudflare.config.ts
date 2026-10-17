import { bindings, defineConfig, defineContainer, exports } from "cf/config";

/**
 * The sandbox control plane. Without a mode this is local development: every
 * upstream is the mock in scripts/mock-upstream.ts and `.dev.vars` holds
 * placeholder secrets. `--mode test` is a deployed test Worker on workers.dev,
 * configured by its secrets file (see README.md, "Deploying to a test account").
 */

const WORKER_NAME = "t3-sandbox-control";

/** One container application; each ThreadSandbox Durable Object starts its own instance. */
const threadSandboxContainer = defineContainer({
  name: `${WORKER_NAME}-thread-sandbox`,
  schedulingPolicy: "durable-object",
  // Each sandbox's stdout and stderr: T3's boot, the clone, Claude Code.
  observability: { enabled: true, logs: { enabled: true } },
  // Built from this branch's T3 server; run `vp run stage` first.
  images: { t3: { dockerfile: "./container/Dockerfile" } },
});

const MOCK = "http://127.0.0.1:8790";

/** Per-mode settings; everything a deployment chooses is a secret (see `env` below). */
const deployedVars = {
  GITHUB_ORIGIN: "https://github.com",
  GITHUB_API_ORIGIN: "https://api.github.com",
  DEBUG_EXEC: "0",
  SLEEP_AFTER_MS: String(10 * 60 * 1000),
  LIFECYCLE_TICK_MS: String(60 * 1000),
  SHARED_S3_REGION: "auto",
  SHARED_BUCKET: `${WORKER_NAME}-shared`,
};

const localVars = {
  GITHUB_ORIGIN: `${MOCK}/github`,
  GITHUB_API_ORIGIN: `${MOCK}/github-api`,
  DEBUG_EXEC: "1",
  // Short, so proofs can watch a settled sandbox fall asleep, but longer than
  // the minute between an open thread's views, so a viewed one stays up.
  SLEEP_AFTER_MS: String(90 * 1000),
  LIFECYCLE_TICK_MS: String(5 * 1000),
  SHARED_S3_REGION: "auto",
  SHARED_BUCKET: `${WORKER_NAME}-shared`,
};

export default defineConfig(({ mode }) => {
  const vars = mode === "test" ? deployedVars : localVars;
  return {
    worker: {
      name: WORKER_NAME,
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "src/worker.ts",
      // Everything, unsampled: logs with invocation logs, traces, and Issues.
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, headSamplingRate: 1, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 1 },
        issues: { enabled: true },
      },
      // The one public hostname, behind Cloudflare Access. Version preview URLs
      // stay off: they are extra hostnames to protect, and previews do not
      // support Durable Object-managed Containers anyway.
      workersDev: true,
      previewUrls: false,
      // The hosted web client (`vp run build:web`), with SPA fallback. The
      // Worker runs first so /s/* and /api never reach assets.
      assets: { notFoundHandling: "single-page-application", runWorkerFirst: true },
      env: {
        ...Object.fromEntries(
          Object.entries(vars).map(([name, value]) => [name, bindings.text(value)]),
        ),
        // Secrets: `.dev.vars` locally (see `.dev.vars.example`), a secrets file when deployed.
        // https://gateway.ai.cloudflare.com/v1/<account>/<gateway>, which may be in another account.
        AI_GATEWAY_URL: bindings.secret(),
        AI_GATEWAY_TOKEN: bindings.secret(),
        GITHUB_WRITE_PAT: bindings.secret(),
        // Optional: without it, only public repositories clone.
        GITHUB_READ_PAT: bindings.secret(),
        // https://<team>.cloudflareaccess.com and the Access application's AUD tag. Until both
        // are set, the Worker refuses every request: it serves loopback hosts only.
        ACCESS_TEAM_DOMAIN: bindings.secret(),
        ACCESS_AUD: bindings.secret(),
        // Optional, for /shared: R2's S3 API (https://<account-id>.r2.cloudflarestorage.com)
        // and an R2 API token's keys, read-only and scoped to the shared bucket.
        SHARED_S3_ENDPOINT: bindings.secret(),
        SHARED_S3_ACCESS_KEY_ID: bindings.secret(),
        SHARED_S3_SECRET_ACCESS_KEY: bindings.secret(),
        // Sandboxes' T3 homes while they sleep, until the sandbox is deleted.
        BACKUPS: bindings.r2({ name: `${WORKER_NAME}-backups` }),
        // ThreadSandbox and SandboxDirectory are reached through ctx.exports, not
        // bindings (see ControlPlaneExports in src/env.ts).
        ASSETS: bindings.assets(),
      },
      exports: {
        ThreadSandbox: exports.durableObject({
          storage: "sqlite",
          container: threadSandboxContainer,
        }),
        SandboxDirectory: exports.durableObject({ storage: "sqlite" }),
      },
    },
    containers: [threadSandboxContainer],
  };
});
