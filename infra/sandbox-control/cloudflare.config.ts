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
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  return {
    AI_GATEWAY_BASE_URL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${required("SANDBOX_AI_GATEWAY")}`,
    GITHUB_ORIGIN: "https://github.com",
    GITHUB_API_ORIGIN: "https://api.github.com",
    PUBLIC_EGRESS_HOSTS: process.env.SANDBOX_PUBLIC_EGRESS_HOSTS?.trim() ?? "",
    DEBUG_EXEC: "0",
    // Until both are set, the Worker refuses every request: it serves loopback hosts only.
    ACCESS_TEAM_DOMAIN: process.env.SANDBOX_ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "") ?? "",
    ACCESS_AUD: process.env.SANDBOX_ACCESS_AUD?.trim() ?? "",
  };
}

const localVars = {
  AI_GATEWAY_BASE_URL: `${MOCK}/gateway/v1/poc-account/poc-gateway`,
  GITHUB_ORIGIN: `${MOCK}/github`,
  GITHUB_API_ORIGIN: `${MOCK}/github-api`,
  PUBLIC_EGRESS_HOSTS: "",
  DEBUG_EXEC: "1",
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
      observability: { enabled: true },
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
