import * as NodeFS from "node:fs";

import { bindings, defineConfig, defineContainer, exports } from "cf/config";

/**
 * The sandbox control plane. Without a mode this is local development: every
 * upstream is the mock in scripts/mock-upstream.ts and `.dev.vars` holds
 * placeholder secrets. `--mode test` is a deployed test Worker on workers.dev,
 * configured from the environment (see README.md, "Deploying to a test account").
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

function deployedVars() {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`--mode test needs ${name} in the environment.`);
    return value;
  };
  assertWebBuiltFor(required("SANDBOX_APP_URL"));
  return {
    AI_GATEWAY_BASE_URL: aiGatewayBaseUrl(required("SANDBOX_AI_GATEWAY_URL")),
    GITHUB_ORIGIN: "https://github.com",
    GITHUB_API_ORIGIN: "https://api.github.com",
    DEBUG_EXEC: "0",
    SLEEP_AFTER_MS: String(10 * 60 * 1000),
    LIFECYCLE_TICK_MS: String(60 * 1000),
    // R2's S3 API for the bucket below, https://<account-id>.r2.cloudflarestorage.com.
    // Unset, sandboxes have no shared mount.
    SHARED_S3_ENDPOINT: process.env.SANDBOX_SHARED_S3_ENDPOINT?.trim().replace(/\/+$/, "") ?? "",
    SHARED_S3_REGION: "auto",
    SHARED_BUCKET: `${WORKER_NAME}-shared`,
    // Until both are set, the Worker refuses every request: it serves loopback hosts only.
    ACCESS_TEAM_DOMAIN: process.env.SANDBOX_ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "") ?? "",
    ACCESS_AUD: process.env.SANDBOX_ACCESS_AUD?.trim() ?? "",
  };
}

/**
 * The web client is built for one origin: anywhere else it takes the Worker for
 * a T3 server and fails to load. `.web-dist` is shared with local builds, so a
 * deploy checks it was built for the origin it serves (`deploy:test` builds it).
 */
function assertWebBuiltFor(appUrl: string) {
  const origin = new URL(appUrl).origin;
  const assets = new URL("./.web-dist/assets/", import.meta.url);
  const built =
    NodeFS.existsSync(assets) &&
    NodeFS.readdirSync(assets).some(
      (file) =>
        file.endsWith(".js") && NodeFS.readFileSync(new URL(file, assets), "utf8").includes(origin),
    );
  if (!built) {
    throw new Error(
      `.web-dist was not built for ${origin}. Run SANDBOX_APP_URL=${origin} vp run build:web.`,
    );
  }
}

/**
 * The gateway's base URL, from its endpoint as the dashboard shows it. The
 * gateway may live in a different account from the Worker. A pasted provider
 * suffix such as `/anthropic` is dropped; the egress broker adds its own.
 */
function aiGatewayBaseUrl(endpoint: string) {
  const match = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([^/]+)\/([^/]+)/.exec(endpoint);
  if (!match) {
    throw new Error(
      "SANDBOX_AI_GATEWAY_URL must look like https://gateway.ai.cloudflare.com/v1/<account>/<gateway>.",
    );
  }
  return `https://gateway.ai.cloudflare.com/v1/${match[1]}/${match[2]}`;
}

const localVars = {
  AI_GATEWAY_BASE_URL: `${MOCK}/gateway/v1/poc-account/poc-gateway`,
  GITHUB_ORIGIN: `${MOCK}/github`,
  GITHUB_API_ORIGIN: `${MOCK}/github-api`,
  DEBUG_EXEC: "1",
  // Short, so proofs can watch a settled sandbox fall asleep.
  SLEEP_AFTER_MS: String(20 * 1000),
  LIFECYCLE_TICK_MS: String(5 * 1000),
  // The mock's S3 API; the shared mount needs placeholder keys in `.dev.vars` too.
  SHARED_S3_ENDPOINT: "http://127.0.0.1:8791",
  SHARED_S3_REGION: "auto",
  SHARED_BUCKET: `${WORKER_NAME}-shared`,
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
};

export default defineConfig(({ mode }) => {
  const vars = mode === "test" ? deployedVars() : localVars;
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
        AI_GATEWAY_TOKEN: bindings.secret(),
        GITHUB_WRITE_PAT: bindings.secret(),
        GITHUB_READ_PAT: bindings.secret(),
        // An R2 API token's S3 keys, read-only and scoped to the shared bucket.
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
