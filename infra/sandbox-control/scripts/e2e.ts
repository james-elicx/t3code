#!/usr/bin/env node
/**
 * End-to-end proofs against a running control plane (`vp run dev`) and mock
 * upstream (`vp run mock`). Creates a fresh sandbox, checks each claim, prints
 * PASS/FAIL with the evidence, and destroys the sandbox (KEEP=1 keeps it).
 *
 *   CONTROL_PLANE=http://localhost:8787 MOCK=http://127.0.0.1:8790 node scripts/e2e.ts
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import WebSocket from "ws";

const control = process.env.CONTROL_PLANE ?? "http://localhost:8787";
const mock = process.env.MOCK ?? "http://127.0.0.1:8790";
const threadId = process.env.THREAD_ID ?? `e2e-${Date.now().toString(36)}`;
const branchPrefix = `t3/${threadId}/`;
/** The sandbox's T3 server, below its path prefix on the control plane. */
const sandboxRoute = `${control}/s/${threadId}`;

const secrets = Object.fromEntries(
  NodeFS.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
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

let viewing: ReturnType<typeof setInterval> | undefined;

async function main() {
  for (const url of [`${control}/api/sandboxes`, `${mock}/__refs`]) {
    await fetch(url).catch(() => {
      throw new Error(`${url} is not reachable. Start \`vp run dev\` and \`vp run mock\` first.`);
    });
  }

  // --- Create, list, proxy -------------------------------------------------
  const started = Date.now();
  await api("", { method: "POST", body: JSON.stringify({ threadId, repo: "acme/demo" }) });
  let summary: {
    status: string;
    lastError: string | null;
    pullRequests: unknown[];
    savedAt: string | null;
  };
  do {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    summary = await api(`/${threadId}`);
    if (summary.lastError) throw new Error(`boot failed: ${summary.lastError}`);
    if (Date.now() - started > 240_000) throw new Error("sandbox did not start in 240s");
  } while (summary.status !== "running");
  // What a client does while the thread is open: without it, a sandbox with no
  // work left sleeps after SLEEP_AFTER_MS.
  viewing = setInterval(
    () => void api(`/${threadId}/wake`, { method: "POST" }).catch(() => {}),
    5000,
  );
  check(
    "sandbox boots a T3 server",
    true,
    `running after ${Math.round((Date.now() - started) / 1000)}s`,
  );

  const listed = (await api("")).sandboxes as Array<{ threadId: string; httpBaseUrl: string }>;
  const entry = listed.find((sandbox) => sandbox.threadId === threadId);
  check("directory lists it with its route", entry?.httpBaseUrl === sandboxRoute, entry ?? listed);

  // Without Access configured the control plane serves loopback hosts only, so a
  // deploy that forgot Access fails closed.
  const elsewhere = await new Promise<string>((resolve, reject) => {
    const target = new URL(`${control}/api/sandboxes`);
    const req = NodeHttp.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { host: "t3-sandbox-control.example.workers.dev" },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(`${response.statusCode} ${body.trim()}`));
      },
    );
    req.on("error", reject);
    req.end();
  });
  check(
    "without Access configured, a non-loopback host gets nothing",
    elsewhere.startsWith("403 "),
    elsewhere,
  );

  const viaProxy = (await (await fetch(`${sandboxRoute}/api/auth/session`)).json()) as {
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
      `${sandboxRoute.replace(/^http/, "ws")}/ws?orchestrationProtocol=2`,
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

  // --- The project ----------------------------------------------------------
  const shell = (await (
    await fetch(`${sandboxRoute}/api/orchestration/shell`, {
      headers: { "x-t3-orchestration-protocol": "2" },
    })
  ).json()) as {
    projects: Array<{ id: string; workspaceRoot: string; repositoryIdentity?: unknown }>;
    threads: unknown[];
  };
  check(
    "the control plane creates the checkout's project, and T3 makes no thread of its own",
    shell.projects.length === 1 &&
      shell.projects[0]!.id === "sandbox:acme/demo" &&
      shell.projects[0]!.workspaceRoot === "/workspace/demo" &&
      shell.threads.length === 0,
    {
      projects: shell.projects.map(({ id, workspaceRoot }) => ({ id, workspaceRoot })),
      threads: shell.threads.length,
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
    get() { curl -s -m 20 -o /tmp/body -w '%{http_code}' "$1"; grep -o '<title>[^<]*' /tmp/body | head -1; }
    echo "https://example.com:              $(get https://example.com/)"
    echo "http://example.com:               $(get http://example.com/)"
    echo "raw TCP to github.com:22 banner:  [$( (sleep 4) | nc -w 5 140.82.112.3 22 2>/dev/null | head -c 20)]"
  `);
  check(
    "other web traffic leaves through the egress proxy; raw TCP does not",
    /https:\/\/example\.com: +200<title>Example Domain/.test(egress.stdout) &&
      /http:\/\/example\.com: +200<title>Example Domain/.test(egress.stdout) &&
      /banner: +\[\]/.test(egress.stdout),
    egress.stdout,
  );

  // --- Sleep and wake ------------------------------------------------------
  clearInterval(viewing);
  const before = await sh(
    `cd /workspace/demo && echo draft > uncommitted.txt && echo ${threadId} > /t3home/userdata/e2e-marker && ` +
      "cat /t3home/userdata/environment-id",
  );
  const environmentBefore = before.stdout.trim();
  const sleepStarted = Date.now();
  const asleep = await api(`/${threadId}/sleep`, { method: "POST" });
  const sleepSeconds = Math.round((Date.now() - sleepStarted) / 1000);
  const whileAsleep = await fetch(`${sandboxRoute}/api/auth/session`);
  const afterPoke = await api(`/${threadId}`);
  check(
    "sleep saves and stops; proxied traffic gets 503 and does not wake it",
    asleep.status === "asleep" &&
      asleep.savedAt !== null &&
      whileAsleep.status === 503 &&
      afterPoke.status === "asleep",
    `saved and stopped in ${sleepSeconds}s; proxy answered ${whileAsleep.status} ` +
      `${(await whileAsleep.text()).trim()}; status afterwards: ${afterPoke.status}`,
  );

  /** Wakes the sandbox as a client opening the thread does, and keeps viewing it. */
  const wake = async () => {
    const started = Date.now();
    await api(`/${threadId}/wake`, { method: "POST" });
    viewing = setInterval(
      () => void api(`/${threadId}/wake`, { method: "POST" }).catch(() => {}),
      5000,
    );
    const phases: string[] = [];
    do {
      await new Promise((resolve) => setTimeout(resolve, 500));
      summary = await api(`/${threadId}`);
      if (phases.at(-1) !== summary.status) phases.push(summary.status);
      if (summary.lastError) throw new Error(`wake failed: ${summary.lastError}`);
      if (Date.now() - started > 240_000) throw new Error("wake did not finish in 240s");
    } while (summary.status !== "running");
    const state = await sh(
      "cd /workspace/demo; git rev-parse --abbrev-ref HEAD; git log -1 --format=%s; " +
        "cat uncommitted.txt 2>/dev/null || echo '(no uncommitted.txt)'; " +
        "cat /t3home/userdata/environment-id /t3home/userdata/e2e-marker",
    );
    const session = (await (await fetch(`${sandboxRoute}/api/auth/session`)).json()) as {
      authenticated: boolean;
    };
    return {
      seconds: Math.round((Date.now() - started) / 1000),
      phases: phases.join(" → "),
      state: state.stdout.trim() + state.stderr,
      authenticated: session.authenticated,
    };
  };
  const t3Home = [environmentBefore, threadId];
  const woken = await wake();
  check(
    "wake restores the workspace from the snapshot and the T3 home from R2",
    woken.state ===
      [`${branchPrefix}work`, `change from ${threadId}`, "draft", ...t3Home].join("\n") &&
      woken.authenticated,
    `awake in ${woken.seconds}s via ${woken.phases}\n` +
      `branch, last commit, uncommitted file, environment id, T3 home marker:\n${woken.state}`,
  );

  // An expired snapshot: the image, the T3 home from R2, and the pushed session branch.
  clearInterval(viewing);
  await api(`/${threadId}/sleep`, { method: "POST" });
  await api(`/${threadId}/forget-snapshot`, { method: "POST" });
  const rebuilt = await wake();
  check(
    "without a snapshot, wake rebuilds from the image, R2 and the pushed session branch",
    rebuilt.state ===
      [`${branchPrefix}work`, `change from ${threadId}`, "(no uncommitted.txt)", ...t3Home].join(
        "\n",
      ) && rebuilt.authenticated,
    `awake in ${rebuilt.seconds}s via ${rebuilt.phases}\n` +
      `branch, last commit, uncommitted file, environment id, T3 home marker:\n${rebuilt.state}`,
  );

  clearInterval(viewing);
  viewing = undefined;
  // Nobody views it and it has no thread with work, so the lifecycle alarm puts it
  // back to sleep (SLEEP_AFTER_MS is 20s locally).
  const idleStarted = Date.now();
  do {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    summary = await api(`/${threadId}`);
    if (Date.now() - idleStarted > 120_000) break;
  } while (summary.status !== "asleep");
  check(
    "an unviewed sandbox with no work left falls asleep on its own",
    summary.status === "asleep",
    `${summary.status} after ${Math.round((Date.now() - idleStarted) / 1000)}s unviewed`,
  );
}

try {
  await main();
} catch (error) {
  failures++;
  console.log(`FAIL  ${String(error)}`);
} finally {
  clearInterval(viewing);
  if (process.env.KEEP !== "1") await api(`/${threadId}`, { method: "DELETE" }).catch(() => {});
}
console.log(failures === 0 ? "\nAll proofs passed." : `\n${failures} proof(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
