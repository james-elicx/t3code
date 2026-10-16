import type { Env } from "./env.ts";
import { directory } from "./SandboxDirectory.ts";
import { SANDBOX_ID_PATTERN } from "./session.ts";
import type { CreateSandboxInput, SandboxSummary } from "./ThreadSandbox.ts";

export { Egress } from "./egress/Egress.ts";
export { SandboxDirectory } from "./SandboxDirectory.ts";
export { ThreadSandbox } from "./ThreadSandbox.ts";

/**
 * The control plane. `<thread-id>.<SANDBOX_DOMAIN>` is proxied into that
 * thread's sandbox; the apex serves the sandbox API and the web client.
 * Cloudflare Access in front of the whole domain authenticates callers.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const sandboxId = sandboxIdFromHost(url.hostname, env.SANDBOX_DOMAIN);
    if (sandboxId) {
      const sandbox = env.THREAD_SANDBOX.getByName(sandboxId);
      if (!(await sandbox.describe())) return text(404, `No sandbox named ${sandboxId}.`);
      return sandbox.fetch(request);
    }
    if (url.pathname === "/api/sandboxes" || url.pathname.startsWith("/api/sandboxes/")) {
      try {
        return await api(request, env, url);
      } catch (error) {
        return text(500, String(error));
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export function sandboxIdFromHost(hostname: string, domain: string): string | null {
  const suffix = `.${domain.toLowerCase()}`;
  const host = hostname.toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return SANDBOX_ID_PATTERN.test(label) ? label : null;
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const [, , , id, action] = url.pathname.split("/");
  const method = request.method;

  if (id === undefined || id === "") {
    if (method === "GET") {
      const sandboxes = await directory(env).list();
      return Response.json({ sandboxes: sandboxes.map((summary) => withRoutes(summary, url)) });
    }
    if (method === "POST") {
      const input = (await request.json()) as Partial<CreateSandboxInput>;
      if (typeof input.threadId !== "string" || !SANDBOX_ID_PATTERN.test(input.threadId)) {
        return text(400, "threadId must be a DNS label: lowercase letters, digits and hyphens.");
      }
      if (typeof input.repo !== "string") return text(400, "repo (owner/name) is required.");
      const summary = await env.THREAD_SANDBOX.getByName(input.threadId).create({
        threadId: input.threadId,
        repo: input.repo,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...(input.title ? { title: input.title } : {}),
      });
      return Response.json(withRoutes(summary, url), { status: 202 });
    }
    return text(405, "Use GET or POST.");
  }

  if (!SANDBOX_ID_PATTERN.test(id)) return text(400, "Invalid sandbox id.");
  const sandbox = env.THREAD_SANDBOX.getByName(id);
  const summary = await sandbox.describe();
  if (!summary) return text(404, `No sandbox named ${id}.`);

  switch (`${method} ${action ?? ""}`) {
    case "GET ":
      return Response.json(withRoutes(summary, url));
    case "DELETE ":
      await sandbox.destroy();
      return new Response(null, { status: 204 });
    case "POST stop":
      await sandbox.stop();
      return Response.json(withRoutes((await sandbox.describe())!, url));
    case "POST snapshot":
      return Response.json(await sandbox.snapshot());
    case "POST restore":
      return Response.json(withRoutes(await sandbox.restore(), url), { status: 202 });
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
 * Where a client reaches the sandbox's T3 server. The client registers it as a
 * normal saved environment with a direct route; the proxy supplies the credential.
 */
function withRoutes(summary: SandboxSummary, url: URL) {
  const http = `${url.protocol}//${summary.threadId}.${url.host}`;
  return {
    ...summary,
    httpBaseUrl: http,
    wsBaseUrl: http.replace(/^http/, "ws"),
  };
}

const text = (status: number, message: string) =>
  new Response(`${message}\n`, { status, headers: { "content-type": "text/plain" } });
