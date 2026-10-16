import { WorkerEntrypoint } from "cloudflare:workers";

import type { EgressProps, Env } from "../env.ts";
import { toAiGatewayRequest } from "./anthropic.ts";
import { decideGraphql } from "./githubGraphql.ts";
import {
  checkCreatePullRequest,
  checkUpdatePullRequest,
  decideGitHubRequest,
  refusedRefUpdates,
  type Credential,
} from "./githubPolicy.ts";
import { PktLineError, readReceivePackCommands, receivePackRejection } from "./pktLine.ts";

/**
 * Every HTTP and HTTPS request a sandbox makes arrives here. The ThreadSandbox
 * Durable Object registers this entrypoint for `*` with the thread id in its
 * props, so the sandbox cannot choose which session it speaks for.
 *
 * Default deny: only Anthropic, GitHub, and the configured public hosts leave.
 */
export class Egress extends WorkerEntrypoint<Env, EgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.hostname) {
        case "api.anthropic.com":
          return await this.anthropic(request);
        case "github.com":
        case "api.github.com":
          return await this.github(request, url);
      }
      if (publicHosts(this.env).has(url.hostname)) return await this.anonymous(request);
      return blocked(`Egress to ${url.hostname} is not allowed from a T3 sandbox.`);
    } catch (error) {
      console.error("egress failed", url.hostname, error);
      return new Response("The sandbox egress proxy failed.", { status: 502 });
    }
  }

  private async anthropic(request: Request) {
    const upstream = toAiGatewayRequest(request, {
      baseUrl: this.env.AI_GATEWAY_BASE_URL,
      token: this.env.AI_GATEWAY_TOKEN,
    });
    if (!upstream) return blocked("Only the Anthropic /v1 API is reachable from a sandbox.");
    return fetch(upstream);
  }

  private anonymous(request: Request) {
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    return fetch(new Request(request, { headers }));
  }

  private async github(request: Request, url: URL) {
    const sandbox = this.env.THREAD_SANDBOX.getByName(this.ctx.props.threadId);
    const session = await sandbox.session();
    if (!session) return blocked("This sandbox has no session.");

    const decision = decideGitHubRequest(
      { method: request.method, host: url.hostname, pathname: url.pathname, search: url.search },
      session,
    );
    if (decision.kind === "deny") return refuse(url, decision.reason);

    let credential = decision.credential;
    let body: BodyInit | null = request.body;
    const headers = new Headers(request.headers);
    switch (decision.check) {
      case "receive-pack": {
        if (headers.get("content-encoding") === "gzip" && request.body) {
          body = request.body.pipeThrough(new DecompressionStream("gzip"));
          headers.delete("content-encoding");
          headers.delete("content-length");
        }
        let parsed;
        try {
          parsed = await readReceivePackCommands(body as ReadableStream<Uint8Array> | null);
        } catch (error) {
          if (error instanceof PktLineError) return refuse(url, error.message);
          throw error;
        }
        const refused = refusedRefUpdates(parsed.updates, session);
        if (refused.size > 0) {
          // Read the pack the client is still sending, so it sees our report rather than a reset.
          await parsed.body.pipeTo(new WritableStream());
          return new Response(receivePackRejection(parsed, refused), {
            headers: { "content-type": "application/x-git-receive-pack-result" },
          });
        }
        body = parsed.body;
        break;
      }
      case "create-pull-request":
      case "update-pull-request":
      case "graphql": {
        const text = await request.text();
        const json = parseJson(text);
        if (decision.check === "graphql") {
          const graphql = decideGraphql(json, session);
          if (graphql.kind === "deny") return refuse(url, graphql.reason);
          credential = graphql.credential;
        } else {
          const reason =
            decision.check === "create-pull-request"
              ? checkCreatePullRequest(json, session)
              : checkUpdatePullRequest(json);
          if (reason) return refuse(url, reason);
        }
        body = text;
        break;
      }
    }

    applyCredential(headers, url.hostname, credential, this.env);
    const origin =
      url.hostname === "github.com" ? this.env.GITHUB_ORIGIN : this.env.GITHUB_API_ORIGIN;
    const upstream = new Request(`${origin.replace(/\/$/, "")}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    const response = await fetch(upstream);

    if (decision.check === "create-pull-request" && response.status === 201) {
      const created = parseJson(await response.clone().text()) as {
        number?: unknown;
        node_id?: unknown;
      } | null;
      if (typeof created?.number === "number" && typeof created.node_id === "string") {
        await sandbox.recordPullRequest({ number: created.number, nodeId: created.node_id });
      }
    }
    return response;
  }
}

function applyCredential(headers: Headers, host: string, credential: Credential, env: Env) {
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("host");
  if (credential === "none") return;
  const token = credential === "write" ? env.GITHUB_WRITE_PAT : env.GITHUB_READ_PAT;
  // git uses Basic auth over smart HTTP; the REST and GraphQL APIs take a bearer token.
  headers.set(
    "authorization",
    host === "github.com" ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`,
  );
}

const publicHosts = (env: Env) =>
  new Set(
    (env.PUBLIC_EGRESS_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  );

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const blocked = (message: string) =>
  new Response(`${message}\n`, { status: 403, headers: { "content-type": "text/plain" } });

/** A 403 whose reason reaches the agent: JSON for the GitHub API, text for git. */
function refuse(url: URL, reason: string): Response {
  const message = `T3 sandbox policy: ${reason}`;
  if (url.hostname === "api.github.com") {
    return Response.json({ message, documentation_url: "" }, { status: 403 });
  }
  return blocked(message);
}
