/**
 * Claude Code in the sandbox talks to `api.anthropic.com` with a placeholder key
 * and no `ANTHROPIC_BASE_URL`. The egress handler sends those requests to
 * Cloudflare AI Gateway instead, where the gateway token (and the provider key
 * stored in the gateway) live.
 */

export interface AiGatewayConfig {
  /** `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>` in production. */
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * The gateway's base URL from its endpoint as the dashboard shows it, or null
 * when it is not one. The gateway may live in a different account from the
 * Worker. A pasted provider suffix such as `/anthropic` is dropped; the
 * rewrite adds its own. Any origin is accepted, for the local mock.
 */
export function aiGatewayBaseUrl(endpoint: string | undefined): string | null {
  return /^(https?:\/\/[^\s]+?\/v1\/[^/\s]+\/[^/\s]+)/.exec(endpoint?.trim() ?? "")?.[1] ?? null;
}

/**
 * What the egress answers itself for Claude Code's organization lookups, which
 * a sandbox has no organization for: no managed settings (Claude Code reads a
 * 204 as "none configured") and no policy restrictions. Refusing them instead
 * reads as a policy it could not verify, and Claude Code retries each start.
 */
export function anthropicOrganizationResponse(request: Request): Response | null {
  if (request.method !== "GET") return null;
  switch (new URL(request.url).pathname) {
    case "/api/claude_code/settings":
      return new Response(null, { status: 204 });
    case "/api/claude_code/policy_limits":
      return Response.json({ restrictions: {} });
  }
  return null;
}

/** Credentials the sandbox might send; each is a stand-in and must not travel on. */
const SANDBOX_CREDENTIAL_HEADERS = ["x-api-key", "authorization", "cookie"];

/** Returns the gateway request, or null when the path is not part of the Messages API surface. */
export function toAiGatewayRequest(request: Request, config: AiGatewayConfig): Request | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) return null;

  const target = `${config.baseUrl.replace(/\/$/, "")}/anthropic${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  for (const name of SANDBOX_CREDENTIAL_HEADERS) headers.delete(name);
  headers.delete("host");
  headers.set("cf-aig-authorization", `Bearer ${config.token}`);
  return new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    // Node requires this for streamed bodies; workerd ignores it.
    duplex: "half",
  } as RequestInit);
}
