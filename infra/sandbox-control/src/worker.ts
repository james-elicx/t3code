import { accessDenial } from "./access.ts";
import { controlPlane, type ControlPlaneExports, type Env } from "./env.ts";
import { directory } from "./SandboxDirectory.ts";
import { isLoopbackHost, parseSandboxPath } from "./routes.ts";
import { SANDBOX_ID_PATTERN } from "./session.ts";
import { githubAuthorization } from "./egress/githubPolicy.ts";
import { parseLaunch, parseRepo } from "./projects.ts";
import {
  SANDBOX_INSTANCES,
  type CreateSandboxInput,
  type SandboxInstance,
  type SandboxSummary,
  type StartSandboxInput,
} from "./ThreadSandbox.ts";

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
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "");
  const audience = env.ACCESS_AUD?.trim();
  if (teamDomain && audience) {
    // The issuer Access puts in its tokens, with or without the scheme pasted.
    const issuer = teamDomain.includes("://") ? teamDomain : `https://${teamDomain}`;
    return accessDenial(request, { teamDomain: issuer, audience });
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
  const [, , , id, action, extra] = url.pathname.split("/");
  const method = request.method;

  if (id === "projects") return projectsApi(request, env, exports, action, extra);
  if (id === "server-config") return serverConfigApi(request, env, exports);

  if (id === undefined || id === "") {
    if (method === "GET") {
      const plane = directory(exports);
      await plane.ensureSlots();
      await plane.ensureServerConfig();
      const [sandboxes, projects] = await Promise.all([plane.list(), plane.projects()]);
      return Response.json({
        sandboxes: sandboxes.map((summary) => withRoutes(summary, url)),
        projects,
      });
    }
    if (method === "POST") {
      const input = (await request.json()) as Partial<CreateSandboxInput>;
      if (typeof input.threadId !== "string" || !SANDBOX_ID_PATTERN.test(input.threadId)) {
        return text(400, "threadId must be a DNS label: lowercase letters, digits and hyphens.");
      }
      if (typeof input.repo !== "string") return text(400, "repo (owner/name) is required.");
      const start = startInput(input);
      if (typeof start === "string") return text(400, start);
      await directory(exports).addProject(input.repo);
      const summary = await exports.ThreadSandbox.getByName(input.threadId).create({
        threadId: input.threadId,
        repo: input.repo,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...start,
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
    // A new thread's first message, into a project's unstarted sandbox.
    case "POST start": {
      const start = startInput(await request.json());
      if (typeof start === "string") return text(400, start);
      if (summary.status !== "unstarted") return text(409, `Sandbox ${id} already has a thread.`);
      return Response.json(withRoutes(await sandbox.start(start), url), { status: 202 });
    }
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

/** The server config clients offer in a sandbox that has not started; see `ensureServerConfig`. */
async function serverConfigApi(
  request: Request,
  env: Env,
  exports: ControlPlaneExports,
): Promise<Response> {
  const plane = directory(exports);
  if (request.method === "GET") {
    const config = await plane.serverConfig();
    return config === null
      ? text(404, "No sandbox has run yet.")
      : new Response(config, { headers: { "content-type": "application/json" } });
  }
  // Development only: back to a control plane no sandbox has run on.
  if (request.method === "DELETE" && env.DEBUG_EXEC === "1") {
    await plane.forgetServerConfig();
    return new Response(null, { status: 204 });
  }
  return text(405, "Use GET.");
}

/** Why the control plane's read token can't use the repository, or null when it can. */
async function unreadableRepository(env: Env, repo: string): Promise<string | null> {
  const authorization = githubAuthorization("api.github.com", env.GITHUB_READ_PAT);
  const response = await fetch(`${env.GITHUB_API_ORIGIN}/repos/${repo}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "t3-sandbox-control",
      ...(authorization ? { authorization } : {}),
    },
  });
  await response.body?.cancel();
  if (response.ok) return null;
  return response.status === 404
    ? `No GitHub repository ${repo} that the control plane's token can read.`
    : `GitHub answered HTTP ${response.status} for ${repo}.`;
}

/** Projects: a GitHub repository each, with an unstarted sandbox ready for its next thread. */
async function projectsApi(
  request: Request,
  env: Env,
  exports: ControlPlaneExports,
  owner: string | undefined,
  name: string | undefined,
): Promise<Response> {
  const plane = directory(exports);
  if (!owner) {
    if (request.method === "GET") return Response.json({ projects: await plane.projects() });
    if (request.method === "POST") {
      const { repo } = (await request.json()) as { repo?: unknown };
      if (typeof repo !== "string") return text(400, "repo (owner/name) is required.");
      try {
        parseRepo(repo);
      } catch (error) {
        return text(400, String(error instanceof Error ? error.message : error));
      }
      // A sandbox would only fail its clone; say so before there is a thread.
      const unreadable = await unreadableRepository(env, repo);
      if (unreadable) return text(400, unreadable);
      await plane.addProject(repo);
      return Response.json(await plane.project(repo), { status: 201 });
    }
    return text(405, "Use GET or POST.");
  }
  if (request.method !== "DELETE" || !name) return text(404, "Not found.");
  await plane.removeProject(`${owner}/${name}`);
  return new Response(null, { status: 204 });
}

/** What starts a sandbox, from a request body, or why it cannot. */
function startInput(value: unknown): StartSandboxInput | string {
  const body = (value ?? {}) as { title?: unknown; instance?: unknown; launch?: unknown };
  if (
    body.instance !== undefined &&
    !SANDBOX_INSTANCES.includes(body.instance as SandboxInstance)
  ) {
    return `instance must be one of ${SANDBOX_INSTANCES.join(", ")}.`;
  }
  const launch = body.launch === undefined ? undefined : parseLaunch(body.launch);
  if (typeof launch === "string") return launch;
  return {
    ...(typeof body.title === "string" && body.title.trim() ? { title: body.title } : {}),
    ...(body.instance ? { instance: body.instance as SandboxInstance } : {}),
    ...(launch ? { launch } : {}),
  };
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
