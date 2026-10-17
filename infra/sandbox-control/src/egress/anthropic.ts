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
