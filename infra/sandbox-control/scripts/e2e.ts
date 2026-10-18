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
/** Commits to acme/demo's main as someone else would; see scripts/mock-upstream.ts. */
const commitToMain = async (body: { lockfile?: boolean }): Promise<string> =>
  (
    (await (
      await fetch(`${mock}/__main`, { method: "POST", body: JSON.stringify(body) })
    ).json()) as {
      commit: string;
    }
  ).commit;
interface Dependencies {
  status: string;
  commit: string | null;
  builtAt: string | null;
  error: string | null;
}
const dependencies = async (): Promise<Dependencies> =>
  ((await api("/projects/acme/demo")) as { dependencies: Dependencies }).dependencies;
/** Polls the project's dependency cache until `done` says so, or 240s pass. */
const untilDependencies = async (done: (deps: Dependencies) => boolean) => {
  const started = Date.now();
  let deps = await dependencies();
  while (!done(deps) && Date.now() - started < 240_000) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    deps = await dependencies();
  }
  return { deps, seconds: Math.round((Date.now() - started) / 1000) };
};
/** Waits for a sandbox's background dependency install to end; its state and log. */
const installed = async (run: typeof sh) =>
  run(
    "for i in $(seq 1 240); do case $(cut -d' ' -f1 /run/t3-sandbox-deps 2>/dev/null) in " +
      "done|failed|none) break;; esac; sleep 1; done; " +
      "cut -d' ' -f1 /run/t3-sandbox-deps; cat /var/log/t3-sandbox-deps.log",
  );
const refs = async (): Promise<Record<string, string>> => (await fetch(`${mock}/__refs`)).json();
const basic = (token: string) =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

let viewing: ReturnType<typeof setInterval> | undefined;
/** Creating a sandbox adds its repository as a project, which teardown removes again. */
let projectExisted = true;

async function main() {
  for (const url of [`${control}/api/sandboxes`, `${mock}/__refs`]) {
    await fetch(url).catch(() => {
      throw new Error(`${url} is not reachable. Start \`vp run dev\` and \`vp run mock\` first.`);
    });
  }

  // --- Create, list, proxy -------------------------------------------------
  projectExisted = ((await api("")).projects as Array<{ repo: string }>).some(
    (project) => project.repo === "acme/demo",
  );
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

  // --- Dependencies ----------------------------------------------------------
  // Adding the project started a build of its dependency cache. This sandbox may
  // have booted before it finished; either way its own install runs in the background.
  const firstInstall = await installed(sh);
  const linked = await sh(
    "cd /workspace/demo && readlink node_modules/demo-lib && " +
      '[ "$(cat node_modules/.t3-sandbox-installed)" = "$(sha256sum pnpm-lock.yaml | cut -d\' \' -f1)" ] && echo marked',
  );
  check(
    "the sandbox installs the checkout's dependencies in the background",
    firstInstall.stdout.startsWith("done\n") && linked.stdout === "../packages/lib\nmarked\n",
    `${firstInstall.stdout.trim()}\n${linked.stdout.trim()}${linked.stderr}`,
  );

  const mainHead = (await refs())["refs/heads/main"];
  const built = await untilDependencies(
    (deps) => deps.status === "ready" && deps.commit === mainHead,
  );
  check(
    "adding a project builds its dependency cache from the default branch",
    built.deps.status === "ready" && built.deps.commit === mainHead,
    `${JSON.stringify(built.deps)} after ${built.seconds}s; main is ${mainHead}`,
  );

  const waits = await sh(`
    sleep 3 & printf 'installing %s\\n' $! > /run/t3-sandbox-deps
    started=$(date +%s); version=$(cd /workspace/demo && pnpm --version 2>/tmp/waited)
    echo "pnpm $version after $(( $(date +%s) - started ))s: $(cat /tmp/waited)"
    printf 'done 1\\n' > /run/t3-sandbox-deps
    tr '\\0' '\\n' < /proc/1/environ | sed -n 's/^PATH=//p'
    C=$(tr '\\0' '\\n' < /proc/1/environ | sed -n 's/^CLAUDE_CONFIG_DIR=//p')
    grep -c /run/t3-sandbox-deps "$C/CLAUDE.md"
  `);
  const [waitLine, t3Path, noted] = waits.stdout.trim().split("\n");
  check(
    "pnpm waits for the background install, on T3's PATH, and Claude is told",
    /^pnpm 11\.1\.1 after [3-9]s: Waiting for the sandbox to finish installing/.test(
      waitLine ?? "",
    ) &&
      (t3Path ?? "").startsWith("/opt/t3/bin:") &&
      noted === "1",
    `${waitLine}\nT3's PATH: ${t3Path}\nCLAUDE.md mentions the install: ${noted}${waits.stderr}`,
  );

  // --- Shared skills and memories -------------------------------------------
  await fetch(`${mock}/__recorded`, { method: "DELETE" });
  const shared = await sh(`
    C=$(tr '\\0' '\\n' < /proc/1/environ | sed -n 's/^CLAUDE_CONFIG_DIR=//p')
    echo "mount:   $(grep ' /shared ' /proc/mounts | cut -d' ' -f3,4 | cut -d, -f1)"
    echo "memory:  $(cat /shared/memories/demo-repo.md)"
    echo "skills:  $(readlink "$C/skills") -> $(ls "$C/skills")"
    echo "skill:   $(sed -n 2p "$C/skills/sandbox-conventions/SKILL.md")"
    echo "import:  $(grep -F @/shared/ "$C/CLAUDE.md")"
    echo "write:   $(touch /shared/memories/x.md 2>/dev/null && echo allowed || echo refused)"
  `);
  const sharedCalls = (await recorded()).filter((request) => request.path.startsWith("s3:"));
  check(
    "the shared bucket is mounted read-only at /shared and handed to Claude",
    /mount: +fuse\S* ro\n/.test(shared.stdout) &&
      shared.stdout.includes("memory:  acme/demo is seeded by the sandbox mock upstream.") &&
      shared.stdout.includes("skills:  /shared/skills -> sandbox-conventions") &&
      shared.stdout.includes("skill:   name: sandbox-conventions") &&
      shared.stdout.includes("import:  @/shared/memories/MEMORY.md") &&
      shared.stdout.includes("write:   refused"),
    shared.stdout + shared.stderr,
  );
  check(
    "the Worker signs the bucket's requests with the real key, and no write reaches it",
    sharedCalls.length > 0 &&
      sharedCalls.every((request) =>
        request.headers.authorization?.includes(`Credential=${secrets.SHARED_S3_ACCESS_KEY_ID}/`),
      ) &&
      sharedCalls.every((request) => request.method === "GET" || request.method === "HEAD"),
    {
      requests: sharedCalls.length,
      methods: [...new Set(sharedCalls.map((request) => request.method))],
      authorization: sharedCalls[0]?.headers.authorization?.replace(/Signature=\w+/, "Signature=…"),
    },
  );

  await fetch(`${mock}/__shared/memories/added-later.md`, {
    method: "PUT",
    body: "Added to the bucket after the sandbox mounted it.\n",
  });
  const later = await sh(
    "for i in $(seq 1 30); do cat /shared/memories/added-later.md 2>/dev/null && exit 0; sleep 1; done; exit 1",
  );
  check(
    "objects added to the bucket later show up in running sandboxes",
    later.exitCode === 0 && later.stdout.includes("after the sandbox mounted it"),
    later.stdout.trim() || later.stderr.trim() || "(not visible after 30s)",
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
  const values = [
    secrets.AI_GATEWAY_TOKEN,
    secrets.GITHUB_WRITE_PAT,
    secrets.GITHUB_READ_PAT,
    secrets.SHARED_S3_ACCESS_KEY_ID,
    secrets.SHARED_S3_SECRET_ACCESS_KEY,
  ];
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

  // --- Settings template ----------------------------------------------------
  // An edit in this sandbox (here straight to the file T3 watches; the Settings UI
  // writes the same file) becomes what the next new sandbox starts with.
  const flipped = await sh(
    `node -e 'const fs=require("fs"),f="/t3home/userdata/settings.json",s=JSON.parse(fs.readFileSync(f));` +
      `s.defaultAutoPull=!s.defaultAutoPull;fs.writeFileSync(f,JSON.stringify(s));console.log(s.defaultAutoPull)'`,
  );
  await new Promise((resolve) => setTimeout(resolve, 8000)); // a lifecycle tick or two
  // The next sandbox's lockfile is newer than the cache it restores.
  const cachedCommit = (await dependencies()).commit;
  const changedHead = await commitToMain({ lockfile: true });
  const second = `${threadId}-b`;
  try {
    await api("", {
      method: "POST",
      body: JSON.stringify({ threadId: second, repo: "acme/demo" }),
    });
    const secondStarted = Date.now();
    let secondSummary: { status: string; lastError: string | null };
    do {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      secondSummary = await api(`/${second}`);
      if (secondSummary.lastError)
        throw new Error(`second boot failed: ${secondSummary.lastError}`);
      if (Date.now() - secondStarted > 240_000) throw new Error("second sandbox did not start");
    } while (secondSummary.status !== "running");
    const inherited = (await api(`/${second}/exec`, {
      method: "POST",
      body: JSON.stringify({
        argv: [
          "node",
          "-p",
          'JSON.parse(require("fs").readFileSync("/t3home/userdata/settings.json")).defaultAutoPull',
        ],
      }),
    })) as { stdout: string };
    check(
      "settings edited in one sandbox are what a new sandbox starts with",
      flipped.stdout.trim() !== "" && inherited.stdout.trim() === flipped.stdout.trim(),
      `defaultAutoPull set to ${flipped.stdout.trim()} in ${threadId}; ${second} started with ${inherited.stdout.trim()}`,
    );
    const secondSh = async (script: string) =>
      (await api(`/${second}/exec`, {
        method: "POST",
        body: JSON.stringify({ argv: ["sh", "-c", script] }),
      })) as { exitCode: number; stdout: string; stderr: string };
    const delta = await installed(secondSh);
    check(
      "a sandbox restores the cache and installs only what its newer lockfile changed",
      delta.stdout.startsWith(`done\ndependency cache: restored ${cachedCommit}\n`) &&
        /^[+-] demo-extra /m.test(delta.stdout),
      delta.stdout.trim(),
    );
  } finally {
    await api(`/${second}`, { method: "DELETE" }).catch(() => {});
  }

  const rebuiltCache = await untilDependencies((deps) => deps.commit === changedHead);
  check(
    "a lockfile change on the default branch rebuilds the cache",
    rebuiltCache.deps.status === "ready" && rebuiltCache.deps.commit === changedHead,
    `${JSON.stringify(rebuiltCache.deps)} ${rebuiltCache.seconds}s after the change`,
  );
  await commitToMain({});
  await new Promise((resolve) => setTimeout(resolve, 25_000)); // two checks
  const unchanged = await dependencies();
  check(
    "a commit that leaves the lockfile alone builds nothing",
    unchanged.status === "ready" && unchanged.builtAt === rebuiltCache.deps.builtAt,
    `${JSON.stringify(unchanged)} 25s after a README-only commit`,
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
    const shared = await sh("cat /shared/memories/demo-repo.md");
    return {
      shared: shared.stdout.trim(),
      seconds: Math.round((Date.now() - started) / 1000),
      phases: phases.join(" → "),
      state: state.stdout.trim() + state.stderr,
      authenticated: session.authenticated,
    };
  };
  const t3Home = [environmentBefore, threadId];
  // Snapshots leave mounts out, so every boot mounts the bucket again.
  const sharedMemory = "acme/demo is seeded by the sandbox mock upstream.";
  const woken = await wake();
  check(
    "wake restores the workspace from the snapshot, the T3 home from R2, and the shared mount",
    woken.state ===
      [`${branchPrefix}work`, `change from ${threadId}`, "draft", ...t3Home].join("\n") &&
      woken.authenticated &&
      woken.shared === sharedMemory,
    `awake in ${woken.seconds}s via ${woken.phases}\n` +
      `branch, last commit, uncommitted file, environment id, T3 home marker:\n${woken.state}\n` +
      `shared memory: ${woken.shared || "(not mounted)"}`,
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
      ) &&
      rebuilt.authenticated &&
      rebuilt.shared === sharedMemory,
    `awake in ${rebuilt.seconds}s via ${rebuilt.phases}\n` +
      `branch, last commit, uncommitted file, environment id, T3 home marker:\n${rebuilt.state}\n` +
      `shared memory: ${rebuilt.shared || "(not mounted)"}`,
  );

  clearInterval(viewing);
  viewing = undefined;
  // Nobody views it and it has no thread with work, so the lifecycle alarm puts it
  // back to sleep (SLEEP_AFTER_MS is 90s locally).
  const idleStarted = Date.now();
  do {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    summary = await api(`/${threadId}`);
    if (Date.now() - idleStarted > 180_000) break;
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
  if (process.env.KEEP !== "1") {
    await api(`/${threadId}`, { method: "DELETE" }).catch(() => {});
    if (!projectExisted) await api("/projects/acme/demo", { method: "DELETE" }).catch(() => {});
  }
}
console.log(failures === 0 ? "\nAll proofs passed." : `\n${failures} proof(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
