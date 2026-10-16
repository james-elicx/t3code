import { beforeAll, describe, expect, it } from "vite-plus/test";

import { accessDenial, type AccessConfig } from "./access.ts";

const config: AccessConfig = {
  teamDomain: "https://team.cloudflareaccess.com",
  audience: "aud-control-plane",
};
const NOW = Date.UTC(2026, 9, 16, 12);

let signer: CryptoKey;
let fetchKeys: typeof fetch;
let otherSigner: CryptoKey;

const encode = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

async function token(
  claims: Record<string, unknown> = {},
  { key = signer, kid = "key-1" }: { key?: CryptoKey; kid?: string } = {},
) {
  const body = `${encode({ alg: "RS256", kid })}.${encode({
    aud: [config.audience],
    iss: config.teamDomain,
    exp: NOW / 1000 + 600,
    email: "dev@example.com",
    ...claims,
  })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)),
  );
  const encodedSignature = btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${body}.${encodedSignature}`;
}

const request = (jwt?: string) =>
  new Request("https://control.example.workers.dev/api/sandboxes", {
    headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
  });

const generate = () =>
  crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

beforeAll(async () => {
  const pair = await generate();
  signer = pair.privateKey;
  otherSigner = (await generate()).privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  fetchKeys = async (input) => {
    expect(String(input)).toBe(`${config.teamDomain}/cdn-cgi/access/certs`);
    return Response.json({ keys: [{ ...jwk, kid: "key-1" }] });
  };
});

describe("accessDenial", () => {
  it("lets a token Access signed for this application through", async () => {
    expect(await accessDenial(request(await token()), config, fetchKeys, NOW)).toBeNull();
  });

  it("refuses a request that did not come through Access", async () => {
    expect(await accessDenial(request(), config, fetchKeys, NOW)).toBe(
      "Sign in through Cloudflare Access.",
    );
  });

  it("refuses a token signed by anyone else", async () => {
    const forged = await token({}, { key: otherSigner });
    expect(await accessDenial(request(forged), config, fetchKeys, NOW)).toBe(
      "Invalid Access token signature.",
    );
    const unknownKey = await token({}, { kid: "key-2" });
    expect(await accessDenial(request(unknownKey), config, fetchKeys, NOW)).toBe(
      "Unknown Access signing key.",
    );
  });

  it("refuses tokens for another application or team, and expired ones", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ aud: ["aud-other-app"] }, "Access token is for another application."],
      [{ iss: "https://other.cloudflareaccess.com" }, "Access token is from another team."],
      [{ exp: NOW / 1000 - 1 }, "Access token expired."],
    ];
    for (const [claims, denial] of cases) {
      expect(await accessDenial(request(await token(claims)), config, fetchKeys, NOW)).toBe(denial);
    }
  });

  it("refuses a token that is not a JWT", async () => {
    expect(await accessDenial(request("not-a-jwt"), config, fetchKeys, NOW)).toBe(
      "Malformed Access token.",
    );
  });
});
