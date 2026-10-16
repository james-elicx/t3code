#!/usr/bin/env node
/**
 * Local stand-in for every upstream the egress broker talks to, so proofs run
 * without real credentials or network:
 *
 *   /gateway/...     Cloudflare AI Gateway: answers like the Messages API,
 *                    streaming when asked, as the Claude CLI does.
 *   /github-api/...  api.github.com: creating a pull request returns #7.
 *   /github/...      github.com git smart HTTP, served by `git http-backend`
 *                    over a seeded bare repository `acme/demo`.
 *
 * Every request is recorded with its headers. `GET /__recorded` returns them,
 * `DELETE /__recorded` clears them, and `GET /__refs` lists the bare repo's refs.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.MOCK_PORT ?? 8790);
const root = mkdtempSync(join(tmpdir(), "t3-sandbox-mock-"));
const bare = join(root, "acme", "demo.git");

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
mkdirSync(join(root, "acme"), { recursive: true });
git("init", "--quiet", "--bare", "--initial-branch=main", bare);
git("-C", bare, "config", "http.receivepack", "true");
const seed = join(root, "seed");
git("init", "--quiet", "--initial-branch=main", seed);
writeFileSync(join(seed, "README.md"), "# acme/demo\n\nSeeded by the sandbox mock upstream.\n");
git("-C", seed, "add", "README.md");
git(
  "-C",
  seed,
  "-c",
  "user.name=Mock",
  "-c",
  "user.email=mock@t3.invalid",
  "commit",
  "--quiet",
  "-m",
  "seed",
);
git("-C", seed, "push", "--quiet", bare, "main");

interface Recorded {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly bodyBytes: number;
  /** For JSON bodies: the fields the proofs check, read before the body is cut. */
  readonly model?: string;
  readonly stream?: boolean;
}
let recorded: Recorded[] = [];

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const record = (request: IncomingMessage, body: Buffer) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
  }
  let fields: { model?: unknown; stream?: unknown } = {};
  try {
    if (request.headers["content-type"]?.includes("json"))
      fields = JSON.parse(new TextDecoder().decode(body));
  } catch {}
  const printable = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(
    new TextDecoder("latin1").decode(body.subarray(0, 2048)),
  );
  recorded.push({
    at: new Date().toISOString(),
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers,
    body: printable
      ? new TextDecoder().decode(body.subarray(0, 2048))
      : `<${body.length} binary bytes>`,
    bodyBytes: body.length,
    ...(typeof fields.model === "string" ? { model: fields.model } : {}),
    ...(typeof fields.stream === "boolean" ? { stream: fields.stream } : {}),
  });
};

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value, null, 2));
};

const MOCK_REPLY = "Hello from the mock AI Gateway.";

/** The Messages API surface the Claude CLI uses, behind AI Gateway's `/anthropic` prefix. */
function anthropic(url: URL, body: Buffer, response: ServerResponse) {
  const path = url.pathname.replace(/^\/gateway\/v1\/[^/]+\/[^/]+\/anthropic/, "");
  if (path === "/v1/messages/count_tokens") return json(response, 200, { input_tokens: 12 });
  if (path.startsWith("/v1/models")) {
    return json(response, 200, {
      data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }],
      has_more: false,
    });
  }
  if (path !== "/v1/messages")
    return json(response, 404, {
      type: "error",
      error: { type: "not_found_error", message: path },
    });

  let input: { model?: string; stream?: boolean } = {};
  try {
    input = JSON.parse(new TextDecoder().decode(body));
  } catch {}
  const model = input.model ?? "claude-opus-5-5";
  const usage = { input_tokens: 12, output_tokens: 9 };
  if (!input.stream) {
    return json(response, 200, {
      id: "msg_mock_gateway",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: MOCK_REPLY }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event: string, data: unknown) =>
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_mock_gateway",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
    },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (const text of ["Hello from ", "the mock ", "AI Gateway."]) {
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  send("message_stop", { type: "message_stop" });
  response.end();
}

function gitHttpBackend(request: IncomingMessage, response: ServerResponse, body: Buffer) {
  const url = new URL(request.url ?? "/", "http://mock");
  // github.com accepts `owner/repo` and `owner/repo.git`; the bare repo is `repo.git`.
  const pathInfo = url.pathname
    .slice("/github".length)
    .replace(/^\/([^/]+)\/([^/]+?)(?:\.git)?\//, "/$1/$2.git/");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: pathInfo,
      REQUEST_METHOD: request.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
      GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
      REMOTE_USER: "sandbox",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  child.stdin.end(body);
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[git http-backend] ${chunk}`));
  child.on("close", () => {
    const all = Buffer.concat(output);
    const split = all.indexOf("\r\n\r\n") !== -1 ? all.indexOf("\r\n\r\n") : all.indexOf("\n\n");
    const separator = all.indexOf("\r\n\r\n") !== -1 ? 4 : 2;
    const head = all.subarray(0, split).toString("utf8");
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.end(all.subarray(split + separator));
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://mock");
  if (url.pathname === "/__recorded") {
    if (request.method === "DELETE") recorded = [];
    return json(response, 200, recorded);
  }
  if (url.pathname === "/__refs") {
    const refs = git("-C", bare, "for-each-ref", "--format=%(refname) %(objectname)");
    return json(
      response,
      200,
      Object.fromEntries(
        refs
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ")),
      ),
    );
  }

  const body = await readBody(request);
  record(request, body);

  if (url.pathname.startsWith("/gateway/")) return anthropic(url, body, response);
  if (url.pathname.startsWith("/github-api/")) {
    const path = url.pathname.slice("/github-api".length);
    if (request.method === "POST" && path === "/repos/acme/demo/pulls") {
      const input = JSON.parse(new TextDecoder().decode(body)) as { head: string; base: string };
      return json(response, 201, {
        number: 7,
        node_id: "PR_kwDOmock7",
        state: "open",
        head: { ref: input.head },
        base: { ref: input.base },
      });
    }
    return json(response, 200, { ok: true, method: request.method, path });
  }
  if (url.pathname.startsWith("/github/")) return gitHttpBackend(request, response, body);
  return json(response, 404, { message: "Unknown mock route" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock upstream listening on http://127.0.0.1:${port} (repos in ${root})`);
});
