import { accessDenial } from "./access.ts";
import { controlPlane, type ControlPlaneExports, type Env } from "./env.ts";
import { directory } from "./SandboxDirectory.ts";
import { isLoopbackHost, parseSandboxPath } from "./routes.ts";
import { SANDBOX_ID_PATTERN } from "./session.ts";
import type { CreateSandboxInput, SandboxSummary } from "./ThreadSandbox.ts";

export { DirectoryBackupGateway, S3Gateway } from "@cloudflare/sandbox";
export { Egress } from "./egress/Egress.ts";
export { SandboxDirectory } from "./SandboxDirectory.ts";
export { ThreadSandbox } from "./ThreadSandbox.ts";

/**
 * The control plane, on one hostname. `/s/<thread-id>/…` is proxied into that
 * thread's sandbox; `/api/sandboxes` is the sandbox API; everything else is the
 * web client. Cloudflare Access in front authenticates every request, and the
 * Worker verifies its token again (see access.ts).
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const exports = controlPlane(ctx);
    const denial = await authorize(request, env, url);
    if (denial) return text(403, denial);

    const sandboxPath = parseSandboxPath(url.pathname);
    if (sandboxPath) {
      const sandbox = exports.ThreadSandbox.getByName(sandboxPath.id);
      if (!(await sandbox.describe())) return text(404, `No sandbox named ${sandboxPath.id}.`);
      url.pathname = sandboxPath.rest;
      return sandbox.fetch(new Request(url, request));
    }
    if (url.pathname === "/api/sandboxes" || url.pathname.startsWith("/api/sandboxes/")) {
      try {
        return await api(request, env, exports, url);
      } catch (error) {
        return text(500, String(error));
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Every request needs a valid Access token. Without Access configured, only
 * loopback hosts are served, which is local development.
 */
async function authorize(request: Request, env: Env, url: URL): Promise<string | null> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    return accessDenial(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
  }
  return isLoopbackHost(url.hostname)
    ? null
    : "Cloudflare Access is not configured for this control plane.";
}

async function api(
  request: Request,
  env: Env,
  exports: ControlPlaneExports,
  url: URL,
): Promise<Response> {
  const [, , , id, action] = url.pathname.split("/");
  const method = request.method;

  if (id === undefined || id === "") {
    if (method === "GET") {
      const sandboxes = await directory(exports).list();
      return Response.json({ sandboxes: sandboxes.map((summary) => withRoutes(summary, url)) });
    }
    if (method === "POST") {
      const input = (await request.json()) as Partial<CreateSandboxInput>;
      if (typeof input.threadId !== "string" || !SANDBOX_ID_PATTERN.test(input.threadId)) {
        return text(400, "threadId must be a DNS label: lowercase letters, digits and hyphens.");
      }
      if (typeof input.repo !== "string") return text(400, "repo (owner/name) is required.");
      const summary = await exports.ThreadSandbox.getByName(input.threadId).create({
        threadId: input.threadId,
        repo: input.repo,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.instance ? { instance: input.instance } : {}),
      });
      return Response.json(withRoutes(summary, url), { status: 202 });
    }
    return text(405, "Use GET or POST.");
  }

  if (!SANDBOX_ID_PATTERN.test(id)) return text(400, "Invalid sandbox id.");
  const sandbox = exports.ThreadSandbox.getByName(id);
  const summary = await sandbox.describe();
  if (!summary) return text(404, `No sandbox named ${id}.`);

  switch (`${method} ${action ?? ""}`) {
    case "GET ":
      return Response.json(withRoutes(summary, url));
    case "DELETE ":
      await sandbox.destroy();
      return new Response(null, { status: 204 });
    // A client has the thread open; boots an asleep sandbox. Call it again every minute.
    case "POST wake":
      return Response.json(withRoutes(await sandbox.wake(), url), { status: 202 });
    case "POST sleep":
      return Response.json(withRoutes(await sandbox.sleep(), url));
    case "POST forget-snapshot":
      if (env.DEBUG_EXEC !== "1") return text(404, "Not found.");
      await sandbox.forgetSnapshot();
      return new Response(null, { status: 204 });
    case "POST exec": {
      if (env.DEBUG_EXEC !== "1") return text(404, "Not found.");
      const body = (await request.json()) as {
        argv?: string[];
        env?: Record<string, string>;
        cwd?: string;
      };
      if (!Array.isArray(body.argv) || body.argv.length === 0)
        return text(400, "argv is required.");
      return Response.json(
        await sandbox.exec(body.argv, {
          ...(body.env ? { env: body.env } : {}),
          ...(body.cwd ? { cwd: body.cwd } : {}),
        }),
      );
    }
  }
  return text(404, "Not found.");
}

/**
 * Where a client reaches the sandbox's T3 server: below its path prefix on this
 * origin. The client registers it as a saved environment with a direct route;
 * the proxy supplies the credential.
 */
function withRoutes(summary: SandboxSummary, url: URL) {
  const http = `${url.origin}/s/${summary.threadId}`;
  return {
    ...summary,
    httpBaseUrl: http,
    wsBaseUrl: `${http.replace(/^http/, "ws")}/ws`,
  };
}

const text = (status: number, message: string) =>
  new Response(`${message}\n`, { status, headers: { "content-type": "text/plain" } });
