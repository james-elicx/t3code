import type { Env } from "./env.ts";
import { githubAuthorization } from "./egress/githubPolicy.ts";

/**
 * A repository's ref advertisement, as git's smart HTTP starts a clone. Used
 * rather than the REST API: without a token that allows 60 requests an hour
 * per IP, which Workers' shared IPs use up.
 */
export function fetchRefAdvertisement(env: Env, repo: string): Promise<Response> {
  const authorization = githubAuthorization("github.com", env.GITHUB_READ_PAT);
  return fetch(`${env.GITHUB_ORIGIN}/${repo}.git/info/refs?service=git-upload-pack`, {
    headers: {
      "user-agent": "git/2 (t3-sandbox-control)",
      ...(authorization ? { authorization } : {}),
    },
  });
}

/** The commit HEAD (the default branch) points at in a ref advertisement; null for an empty repository. */
export function advertisedHead(advertisement: string): string | null {
  // pkt-lines: four hex digits of length (counting themselves), or 0000 for a flush.
  let at = 0;
  while (at + 4 <= advertisement.length) {
    const length = Number.parseInt(advertisement.slice(at, at + 4), 16);
    if (Number.isNaN(length) || (length > 0 && length < 4)) return null;
    if (length === 0) {
      at += 4;
      continue;
    }
    const head = /^([0-9a-f]{40}|[0-9a-f]{64}) HEAD(?:\0|\n|$)/.exec(
      advertisement.slice(at + 4, at + length),
    );
    if (head) return head[1]!;
    at += length;
  }
  return null;
}

/** The default branch's commit, or null when the repository is empty or unreadable. */
export async function defaultBranchHead(env: Env, repo: string): Promise<string | null> {
  const response = await fetchRefAdvertisement(env, repo);
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  return advertisedHead(await response.text());
}

/**
 * A file at a commit, or null when the commit has none. From raw.githubusercontent.com,
 * which the REST API's anonymous limit does not apply to.
 */
export async function fileAt(
  env: Env,
  repo: string,
  commit: string,
  path: string,
): Promise<ArrayBuffer | null> {
  const authorization = githubAuthorization("api.github.com", env.GITHUB_READ_PAT);
  const response = await fetch(`${env.GITHUB_RAW_ORIGIN}/${repo}/${commit}/${path}`, {
    headers: authorization ? { authorization } : {},
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub answered HTTP ${response.status} for ${repo}/${path}.`);
  }
  return response.arrayBuffer();
}
