import { describe, expect, it } from "vite-plus/test";

import { aiGatewayBaseUrl, toAiGatewayRequest } from "./anthropic.ts";

const config = {
  baseUrl: "https://gateway.ai.cloudflare.com/v1/account-id/t3-sandboxes/",
  token: "real-gateway-token",
};

describe("toAiGatewayRequest", () => {
  it("sends Messages API calls to AI Gateway with the gateway token instead of the sandbox key", async () => {
    const request = new Request("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "x-api-key": "sk-ant-placeholder",
        authorization: "Bearer placeholder",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [] }),
    });
    const upstream = toAiGatewayRequest(request, config)!;
    expect(upstream.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account-id/t3-sandboxes/anthropic/v1/messages?beta=true",
    );
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("cf-aig-authorization")).toBe("Bearer real-gateway-token");
    expect(upstream.headers.get("x-api-key")).toBeNull();
    expect(upstream.headers.get("authorization")).toBeNull();
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(await upstream.json()).toMatchObject({ model: "claude-sonnet-5" });
  });

  it("refuses non-API paths such as OAuth and telemetry", () => {
    expect(
      toAiGatewayRequest(new Request("https://api.anthropic.com/api/oauth/token"), config),
    ).toBeNull();
  });
});

describe("aiGatewayBaseUrl", () => {
  it("takes the gateway's endpoint as the dashboard shows it, with or without a provider", () => {
    const base = "https://gateway.ai.cloudflare.com/v1/account-id/t3-sandboxes";
    expect(aiGatewayBaseUrl(base)).toBe(base);
    expect(aiGatewayBaseUrl(` ${base}/anthropic\n`)).toBe(base);
    expect(aiGatewayBaseUrl(`${base}/`)).toBe(base);
    expect(aiGatewayBaseUrl("http://127.0.0.1:8790/gateway/v1/poc-account/poc-gateway")).toBe(
      "http://127.0.0.1:8790/gateway/v1/poc-account/poc-gateway",
    );
  });

  it("is null for anything that is not a gateway endpoint", () => {
    expect(aiGatewayBaseUrl(undefined)).toBeNull();
    expect(aiGatewayBaseUrl("")).toBeNull();
    expect(aiGatewayBaseUrl("https://gateway.ai.cloudflare.com/v1/account-id")).toBeNull();
    expect(aiGatewayBaseUrl("gateway.ai.cloudflare.com/v1/a/g")).toBeNull();
  });
});
