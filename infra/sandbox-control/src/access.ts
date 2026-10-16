/**
 * Cloudflare Access in front of the control plane. Access signs a JWT into
 * `Cf-Access-Jwt-Assertion` on every request it lets through; the Worker checks
 * it again, so a missing or misconfigured Access policy fails closed instead of
 * handing out every sandbox. `ctx.access` would do this for us, but Workers with
 * static assets do not receive it, so the token is verified here.
 */

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com` */
  readonly teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  readonly audience: string;
}

interface Jwk extends JsonWebKey {
  readonly kid: string;
}

const keyCache = new Map<string, { keys: Map<string, CryptoKey>; fetchedAt: number }>();
const KEY_CACHE_MS = 10 * 60 * 1000;

/** Why a request is refused, or null when its Access token is valid. */
export async function accessDenial(
  request: Request,
  config: AccessConfig,
  fetchKeys: typeof fetch = fetch,
  now = Date.now(),
): Promise<string | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return "Sign in through Cloudflare Access.";
  const parts = token.split(".");
  if (parts.length !== 3) return "Malformed Access token.";
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number };
  try {
    header = JSON.parse(decodeText(encodedHeader));
    payload = JSON.parse(decodeText(encodedPayload));
  } catch {
    return "Malformed Access token.";
  }
  if (header.alg !== "RS256" || !header.kid) return "Unsupported Access token.";

  const key = await signingKey(config.teamDomain, header.kid, fetchKeys, now);
  if (!key) return "Unknown Access signing key.";
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBytes(encodedSignature),
    signed,
  );
  if (!valid) return "Invalid Access token signature.";

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) return "Access token is for another application.";
  if (payload.iss !== config.teamDomain) return "Access token is from another team.";
  const seconds = now / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return "Access token expired.";
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) {
    return "Access token is not valid yet.";
  }
  return null;
}

/** The team's signing key by id, refetching once when Access has rotated keys. */
async function signingKey(
  teamDomain: string,
  kid: string,
  fetchKeys: typeof fetch,
  now: number,
): Promise<CryptoKey | null> {
  const cached = keyCache.get(teamDomain);
  if (cached && now - cached.fetchedAt < KEY_CACHE_MS && cached.keys.has(kid)) {
    return cached.keys.get(kid)!;
  }
  const response = await fetchKeys(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) return null;
  const { keys: jwks } = (await response.json()) as { keys: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks) {
    if (jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  keyCache.set(teamDomain, { keys, fetchedAt: now });
  return keys.get(kid) ?? null;
}

function decodeBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const decodeText = (base64url: string) => new TextDecoder().decode(decodeBytes(base64url));
