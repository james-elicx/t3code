#!/usr/bin/env node
/**
 * End-to-end proofs against a running control plane (`vp run dev`) and mock
 * upstream (`vp run mock`). Creates a fresh sandbox, checks each claim, prints
 * PASS/FAIL with the evidence, and destroys the sandbox (KEEP=1 keeps it).
 *
 *   CONTROL_PLANE=http://localhost:8787 MOCK=http://127.0.0.1:8790 node scripts/e2e.ts
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const control = process.env.CONTROL_PLANE ?? "http://localhost:8787";
const mock = process.env.MOCK ?? "http://127.0.0.1:8790";
const threadId = process.env.THREAD_ID ?? `e2e-${Date.now().toString(36)}`;
const branchPrefix = `t3/${threadId}/`;
const sandboxOrigin = control.replace("://", `://${threadId}.`);

const secrets = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.split("=", 2) as [string, string]),
);

let failures = 0;
function check(name: string, ok: boolean, evidence: unknown) {
  if (!ok) failures++;
  const detail = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail.trim().replaceAll("\n", "\n      ")}`,
  );
}

const api = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${control}/api/sandboxes${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${response.status} ${body}`);
  return body ? JSON.parse(body) : null;
};

/** Runs a shell script in the sandbox (the dev-only exec endpoint). */
const sh = async (script: string) =>
  (await api(`/${threadId}/exec`, {
    method: "POST",
    body: JSON.stringify({ argv: ["sh", "-c", script] }),
  })) as { exitCode: number; stdout: string; stderr: string };

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  model?: string;
  stream?: boolean;
}
const recorded = async (): Promise<Recorded[]> => (await fetch(`${mock}/__recorded`)).json();
const refs = async (): Promise<Record<string, string>> => (await fetch(`${mock}/__refs`)).json();
const basic = (token: string) =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

async function main() {
  for (const url of [`${control}/api/sandboxes`, `${mock}/__refs`]) {
    await fetch(url).catch(() => {
      throw new Error(`${url} is not reachable. Start \`vp run dev\` and \`vp run mock\` first.`);
    });
  }

  // --- Create, list, proxy -------------------------------------------------
  const started = Date.now();
  await api("", { method: "POST", body: JSON.stringify({ threadId, repo: "acme/demo" }) });
  let summary: { status: string; lastError: string | null; pullRequests: unknown[] };
  do {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    summary = await api(`/${threadId}`);
    if (summary.lastError) throw new Error(`boot failed: ${summary.lastError}`);
    if (Date.now() - started > 240_000) throw new Error("sandbox did not start in 240s");
  } while (summary.status !== "running");
  check(
    "sandbox boots a T3 server",
    true,
    `running after ${Math.round((Date.now() - started) / 1000)}s`,
  );

  const listed = (await api("")).sandboxes as Array<{ threadId: string; httpBaseUrl: string }>;
  const entry = listed.find((sandbox) => sandbox.threadId === threadId);
  check("directory lists it with its route", entry?.httpBaseUrl === sandboxOrigin, entry ?? listed);

  const viaProxy = (await (await fetch(`${sandboxOrigin}/api/auth/session`)).json()) as {
    authenticated: boolean;
  };
  const direct = JSON.parse((await sh("curl -s http://127.0.0.1:3773/api/auth/session")).stdout);
  check(
    "proxy supplies the T3 credential; the server itself requires one",
    viaProxy.authenticated === true && direct.authenticated === false,
    { viaProxy: viaProxy.authenticated, withoutCredential: direct.authenticated },
  );

  const pong = await new Promise<string>((resolve) => {
    const socket = new WebSocket(
      `${sandboxOrigin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2`,
    );
    const timer = setTimeout(() => resolve("timeout"), 10_000);
    socket.on("open", () => socket.send(JSON.stringify({ _tag: "Ping" })));
    socket.on("message", (message) => {
      clearTimeout(timer);
      socket.close();
      resolve(String(message));
    });
    socket.on("unexpected-response", (_request, response) =>
      resolve(`HTTP ${response.statusCode}`),
    );
    socket.on("error", (error) => resolve(`error ${error.message}`));
  });
  const wsDirect = await sh(
    "curl -s -o /dev/null -w '%{http_code}' -H 'connection: Upgrade' -H 'upgrade: websocket' " +
      "-H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' " +
      "'http://127.0.0.1:3773/ws?orchestrationProtocol=2'",
  );
  check(
    "WebSocket RPC works through the proxy",
    pong.includes('"Pong"') && wsDirect.stdout === "401",
    {
      viaProxy: pong,
      withoutCredential: wsDirect.stdout,
    },
  );

  // --- Anthropic through AI Gateway ---------------------------------------
  await fetch(`${mock}/__recorded`, { method: "DELETE" });
  const claude = await sh(
    `curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" ` +
      `-H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' ` +
      `-d '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'`,
  );
  const gatewayCall = (await recorded()).find((request) => request.path.startsWith("/gateway/"));
  check(
    "api.anthropic.com is rewritten to AI Gateway with the gateway token added outside",
    claude.stdout.includes("msg_mock_gateway") &&
      gatewayCall?.path === "/gateway/v1/poc-account/poc-gateway/anthropic/v1/messages" &&
      gatewayCall.headers["cf-aig-authorization"] === `Bearer ${secrets.AI_GATEWAY_TOKEN}` &&
      gatewayCall.headers["x-api-key"] === undefined &&
      gatewayCall.headers.authorization === undefined,
    {
      sandboxSaw: JSON.parse(claude.stdout || "{}").content?.[0]?.text,
      upstreamPath: gatewayCall?.path,
      upstreamHeaders: {
        "cf-aig-authorization": gatewayCall?.headers["cf-aig-authorization"],
        "x-api-key": gatewayCall?.headers["x-api-key"] ?? "(absent)",
      },
    },
  );

  // --- The thread: its checkout and Claude --------------------------------
  const checkout = await sh(
    "cd /workspace/demo && git rev-parse --abbrev-ref HEAD && " +
      'node -p \'JSON.parse(require("fs").readFileSync("/t3home/userdata/settings.json")).defaultModelSelection.model\'',
  );
  check(
    "the sandbox boots on its session branch with Claude Opus 5.5 as the default",
    checkout.stdout.trim() === `${branchPrefix}work\nclaude-opus-5-5`,
    checkout.stdout + checkout.stderr,
  );

  await fetch(`${mock}/__recorded`, { method: "DELETE" });
  const cli = await sh(`cd /workspace/demo && claude -p "Say hello." 2>&1`);
  const cliCall = (await recorded()).find((request) =>
    /\/anthropic\/v1\/messages(\?|$)/.test(request.path),
  );
  check(
    "Claude Code's own request streams through AI Gateway with the credential added outside",
    cli.stdout.includes("Hello from the mock AI Gateway.") &&
      cliCall?.stream === true &&
      cliCall.headers["cf-aig-authorization"] === `Bearer ${secrets.AI_GATEWAY_TOKEN}` &&
      cliCall.headers["x-api-key"] === undefined,
    {
      claudeSaid: cli.stdout.trim(),
      upstream: `${cliCall?.method} ${cliCall?.path}`,
      model: cliCall?.model,
      stream: cliCall?.stream,
      "x-api-key": cliCall?.headers["x-api-key"] ?? "(absent)",
    },
  );

  // --- Git ----------------------------------------------------------------
  await fetch(`${mock}/__recorded`, { method: "DELETE" });
  const mainBefore = (await refs())["refs/heads/main"];
  const push = await sh(
    `set -e; cd /workspace/demo; git fetch -q origin; ` +
      `echo "${threadId}" >> README.md; git commit -qam "change from ${threadId}"; ` +
      `git push origin HEAD:refs/heads/${branchPrefix}work 2>&1`,
  );
  check(
    "push the boot checkout to the session branch",
    push.exitCode === 0,
    push.stdout + push.stderr,
  );

  const afterAllowed = (await recorded()).length;
  const pushMain = await sh("cd /workspace/demo && git push origin HEAD:refs/heads/main 2>&1");
  const pushTag = await sh("cd /workspace/demo && git tag v-e2e && git push origin v-e2e 2>&1");
  const pushOther = await sh(
    "cd /workspace/demo && git push origin HEAD:refs/heads/t3/another-thread/x 2>&1",
  );
  const refsAfter = await refs();
  const rejectedPosts = (await recorded())
    .slice(afterAllowed)
    .filter((request) => request.method === "POST" && request.path.endsWith("/git-receive-pack"));
  check(
    "pushes to main, a tag, and another thread's branch are rejected before GitHub",
    [pushMain, pushTag, pushOther].every(
      (result) => result.exitCode !== 0 && result.stdout.includes("[remote rejected]"),
    ) &&
      refsAfter["refs/heads/main"] === mainBefore &&
      refsAfter["refs/tags/v-e2e"] === undefined &&
      refsAfter[`refs/heads/${branchPrefix}work`] !== undefined &&
      rejectedPosts.length === 0,
    [pushMain.stdout, pushTag.stdout, pushOther.stdout]
      .map((output) => output.split("\n").find((line) => line.includes("remote rejected")))
      .join("\n") +
      `\nupstream main unchanged: ${refsAfter["refs/heads/main"] === mainBefore}; ` +
      `receive-pack POSTs reaching GitHub for rejected pushes: ${rejectedPosts.length}`,
  );

  const gitCalls = await recorded();
  const uploadAuth = gitCalls.find((request) => request.path.includes("git-upload-pack"))?.headers
    .authorization;
  const receiveAuth = gitCalls.find((request) => request.path.endsWith("/git-receive-pack"))
    ?.headers.authorization;
  check(
    "fetches use the read PAT and pushes the write PAT, both added outside",
    uploadAuth === basic(secrets.GITHUB_READ_PAT!) &&
      receiveAuth === basic(secrets.GITHUB_WRITE_PAT!),
    { uploadPack: uploadAuth, receivePack: receiveAuth },
  );

  // --- GitHub API ---------------------------------------------------------
  const github = await sh(`
    c() { code=$(curl -s -o /tmp/body -w '%{http_code}' -H "authorization: Bearer $GH_TOKEN" \\
      -H 'content-type: application/json' "$@"); echo "$code $(tr -d '\\n' < /tmp/body | head -c 120)"; }
    A=https://api.github.com/repos/acme/demo
    echo "create PR from main:      $(c -XPOST $A/pulls -d '{"head":"main","base":"main","title":"x"}')"
    echo "create PR from session:   $(c -XPOST $A/pulls -d '{"head":"${branchPrefix}work","base":"main","title":"x"}')"
    echo "edit recorded PR title:   $(c -XPATCH $A/pulls/7 -d '{"title":"y"}')"
    echo "change recorded PR base:  $(c -XPATCH $A/pulls/7 -d '{"base":"dev"}')"
    echo "merge recorded PR:        $(c -XPUT $A/pulls/7/merge -d '{}')"
    echo "comment on unrecorded PR: $(c -XPOST $A/issues/8/comments -d '{"body":"x"}')"
    echo "GraphQL merge mutation:   $(c -XPOST https://api.github.com/graphql -d '{"query":"mutation { mergePullRequest(input: {pullRequestId: \\"PR_kwDOmock7\\"}) { clientMutationId } }"}')"
    echo "write to another repo:    $(c -XPOST https://api.github.com/repos/evil/repo/pulls -d '{}')"
  `);
  const codes = github.stdout
    .trim()
    .split("\n")
    .map((line) => line.split(": ")[1]?.trim().slice(0, 3));
  const prs = (await api(`/${threadId}`)).pullRequests;
  check(
    "GitHub API: own PRs only, no base changes, no merges",
    codes.join(",") === "403,201,200,403,403,403,403,403" &&
      JSON.stringify(prs) === JSON.stringify([{ number: 7, nodeId: "PR_kwDOmock7" }]),
    `${github.stdout}recorded on the session: ${JSON.stringify(prs)}`,
  );

  // --- Secrets and egress -------------------------------------------------
  const values = [secrets.AI_GATEWAY_TOKEN, secrets.GITHUB_WRITE_PAT, secrets.GITHUB_READ_PAT];
  const leak = await sh(
    `(env; tr '\\0' '\\n' < /proc/1/environ) | grep -F ${values.map((value) => `-e '${value}'`).join(" ")}; ` +
      `grep -rlF ${values.map((value) => `-e '${value}'`).join(" ")} / ` +
      `--exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null; true`,
  );
  const placeholders = await sh("env | grep -E '^(ANTHROPIC_API_KEY|GH_TOKEN)='");
  check(
    "no real credential exists in the sandbox's environment or filesystem",
    leak.stdout.trim() === "",
    `matches: ${leak.stdout.trim() || "(none)"}\nwhat the sandbox holds instead:\n${placeholders.stdout}`,
  );

  const egress = await sh(`
    get() { code=$(curl -s -m 10 -o /tmp/body -w '%{http_code}' "$1"); echo "$code $(cat /tmp/body)"; }
    echo "https://example.com:              $(get https://example.com/)"
    echo "http://example.com:               $(get http://example.com/)"
    echo "raw TCP to github.com:22 banner:  [$( (sleep 4) | nc -w 5 140.82.112.3 22 2>/dev/null | head -c 20)]"
  `);
  check(
    "everything else is blocked",
    /https:\/\/example\.com: +403 Egress to example\.com is not allowed/.test(egress.stdout) &&
      /http:\/\/example\.com: +403 Egress to example\.com is not allowed/.test(egress.stdout) &&
      /banner: +\[\]/.test(egress.stdout),
    egress.stdout,
  );

  // --- Snapshot and restore ------------------------------------------------
  if (process.env.SKIP_SNAPSHOT !== "1") {
    const snapshot = await api(`/${threadId}/snapshot`, { method: "POST" });
    await api(`/${threadId}/restore`, { method: "POST" });
    const restoreStarted = Date.now();
    do {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      summary = await api(`/${threadId}`);
      if (Date.now() - restoreStarted > 240_000) throw new Error("restore did not finish in 240s");
    } while (summary.status !== "running");
    const restored = await sh("cd /workspace/demo && git log -1 --format=%s");
    const session = (await (await fetch(`${sandboxOrigin}/api/auth/session`)).json()) as {
      authenticated: boolean;
    };
    check(
      "snapshot and restore keep the workspace",
      restored.stdout.trim() === `change from ${threadId}` && session.authenticated === true,
      `snapshot ${snapshot.id} (${Math.round(snapshot.size / 1e6)} MB); ` +
        `restored in ${Math.round((Date.now() - restoreStarted) / 1000)}s; ` +
        `last commit "${restored.stdout.trim()}"; proxy authenticated: ${session.authenticated}`,
    );
  }
}

try {
  await main();
} catch (error) {
  failures++;
  console.log(`FAIL  ${String(error)}`);
} finally {
  if (process.env.KEEP !== "1") await api(`/${threadId}`, { method: "DELETE" }).catch(() => {});
}
console.log(failures === 0 ? "\nAll proofs passed." : `\n${failures} proof(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
