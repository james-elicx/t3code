import { SANDBOX_ID_PATTERN } from "./session.ts";

export const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";

const SANDBOX_PATH = /^\/s\/([^/]+)(\/.*)?$/;

/** `/s/<id>/rest` → the sandbox and the path its T3 server sees. */
export function parseSandboxPath(pathname: string): { id: string; rest: string } | null {
  const match = SANDBOX_PATH.exec(pathname);
  if (!match || !SANDBOX_ID_PATTERN.test(match[1]!)) return null;
  return { id: match[1]!, rest: match[2] ?? "/" };
}
