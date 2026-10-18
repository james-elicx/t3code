#!/usr/bin/env node
/**
 * Local stand-in for every upstream the egress broker talks to, so proofs run
 * without real credentials or network:
 *
 *   /gateway/...     Cloudflare AI Gateway: answers like the Messages API,
 *                    streaming when asked, as the Claude CLI does.
 *   /github-api/...  api.github.com: a repository exists when it is served below;
 *                    creating a pull request returns #7.
 *   /github/...      github.com git smart HTTP, served by `git http-backend`
 *                    over a seeded bare repository `acme/demo`, a tiny pnpm
 *                    workspace whose install needs no registry.
 *   /github-raw/...  raw.githubusercontent.com over the same repositories.
 *
 * Every request is recorded with its headers. `GET /__recorded` returns them,
 * `DELETE /__recorded` clears them, and `GET /__refs` lists the bare repo's refs.
 * `POST /__main` commits to acme/demo's main as someone else would: a README
 * change, or with `{"lockfile":true}` adding or removing the root's dependency
 * on the `demo-extra` workspace package, which changes pnpm-lock.yaml.
 *
 * A second port (MOCK_S3_PORT, 8791) stands in for R2's S3 API with the reads
 * s3fs makes, over a seeded directory of shared skills and memories; any bucket
 * name serves it. `PUT /__shared/<key>` on the first port adds or replaces an
 * object there. S3 requests are recorded too, under the path `s3:/...`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const port = Number(process.env.MOCK_PORT ?? 8790);
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-mock-"));
const bare = NodePath.join(root, "acme", "demo.git");

const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
NodeFS.mkdirSync(NodePath.join(root, "acme"), { recursive: true });
git("init", "--quiet", "--bare", "--initial-branch=main", bare);
git("-C", bare, "config", "http.receivepack", "true");
const seed = NodePath.join(root, "seed");
git("init", "--quiet", "--initial-branch=main", seed);
/** The workspace's root package.json, depending on `demo-lib` and optionally `demo-extra`. */
const rootPackage = (extra: boolean) =>
  `${JSON.stringify(
    {
      name: "demo",
      private: true,
      packageManager: "pnpm@11.1.1",
      dependencies: {
        ...(extra ? { "demo-extra": "workspace:*" } : {}),
        "demo-lib": "workspace:*",
      },
    },
    null,
    2,
  )}\n`;
/** What pnpm 11.1.1 writes for `rootPackage(extra)`. */
const lockfile = (extra: boolean) =>
  [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    ...(extra
      ? [
          "      demo-extra:",
          "        specifier: workspace:*",
          "        version: link:packages/extra",
        ]
      : []),
    "      demo-lib:",
    "        specifier: workspace:*",
    "        version: link:packages/lib",
    "",
    "  packages/extra: {}",
    "",
    "  packages/lib: {}",
    "",
  ].join("\n");
const SEED: Record<string, string> = {
  "README.md": "# acme/demo\n\nSeeded by the sandbox mock upstream.\n",
  "package.json": rootPackage(false),
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "pnpm-lock.yaml": lockfile(false),
  "packages/lib/package.json": '{ "name": "demo-lib", "version": "1.0.0" }\n',
  "packages/extra/package.json": '{ "name": "demo-extra", "version": "1.0.0" }\n',
};
const commitToMain = (files: Record<string, string>, message: string) => {
  for (const [path, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(seed, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(seed, path), content);
  }
  git("-C", seed, "add", "-A");
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
    message,
  );
  git("-C", seed, "push", "--quiet", bare, "main");
  return git("-C", seed, "rev-parse", "HEAD");
};
commitToMain(SEED, "seed");
let dependsOnExtra = false;

const s3Port = Number(process.env.MOCK_S3_PORT ?? 8791);
const shared = NodePath.join(root, "shared");
const SHARED_SEED: Record<string, string> = {
  "skills/sandbox-conventions/SKILL.md":
    "---\nname: sandbox-conventions\ndescription: How work is done in a T3 sandbox.\n---\n\nPush to the sandbox's own branch only.\n",
  "memories/MEMORY.md": "- [Demo repo](demo-repo.md) — acme/demo is the mock repository\n",
  "memories/demo-repo.md": "acme/demo is seeded by the sandbox mock upstream.\n",
};
const writeShared = (key: string, content: Buffer | string) => {
  const file = NodePath.join(shared, key);
  if (!file.startsWith(`${shared}/`)) throw new Error(`bad key ${key}`);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, content);
};
for (const [key, content] of Object.entries(SHARED_SEED)) writeShared(key, content);

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

const readBody = async (request: NodeHttp.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const record = (request: NodeHttp.IncomingMessage, body: Buffer, path = request.url ?? "/") => {
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
    path,
    headers,
    body: printable
      ? new TextDecoder().decode(body.subarray(0, 2048))
      : `<${body.length} binary bytes>`,
    bodyBytes: body.length,
    ...(typeof fields.model === "string" ? { model: fields.model } : {}),
    ...(typeof fields.stream === "boolean" ? { stream: fields.stream } : {}),
  });
};

const json = (response: NodeHttp.ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value, null, 2));
};

const MOCK_REPLY = "Hello from the mock AI Gateway.";

/** The Messages API surface the Claude CLI uses, behind AI Gateway's `/anthropic` prefix. */
function anthropic(url: URL, body: Buffer, response: NodeHttp.ServerResponse) {
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

function gitHttpBackend(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  body: Buffer,
) {
  const url = new URL(request.url ?? "/", "http://mock");
  // github.com accepts `owner/repo` and `owner/repo.git`; the bare repo is `repo.git`.
  const pathInfo = url.pathname
    .slice("/github".length)
    .replace(/^\/([^/]+)\/([^/]+?)(?:\.git)?\//, "/$1/$2.git/");
  const child = NodeChildProcess.spawn("git", ["http-backend"], {
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

const server = NodeHttp.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://mock");
  if (url.pathname === "/__recorded") {
    if (request.method === "DELETE") recorded = [];
    return json(response, 200, recorded);
  }
  if (url.pathname.startsWith("/__shared/") && request.method === "PUT") {
    writeShared(
      decodeURIComponent(url.pathname.slice("/__shared/".length)),
      await readBody(request),
    );
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/__main" && request.method === "POST") {
    const input = JSON.parse(new TextDecoder().decode(await readBody(request)) || "{}") as {
      lockfile?: boolean;
    };
    if (input.lockfile) dependsOnExtra = !dependsOnExtra;
    const commit = input.lockfile
      ? commitToMain(
          {
            "package.json": rootPackage(dependsOnExtra),
            "pnpm-lock.yaml": lockfile(dependsOnExtra),
          },
          `${dependsOnExtra ? "depend on" : "drop"} demo-extra`,
        )
      : commitToMain(
          {
            "README.md": `${NodeFS.readFileSync(NodePath.join(seed, "README.md"), "utf8")}More.\n`,
          },
          "touch the README",
        );
    return json(response, 200, { commit });
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
    // A repository exists when the mock serves its git remote.
    const repository = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (request.method === "GET" && repository) {
      const exists = NodeFS.existsSync(NodePath.join(root, repository[1]!, `${repository[2]}.git`));
      return exists
        ? json(response, 200, { full_name: `${repository[1]}/${repository[2]}`, private: true })
        : json(response, 404, { message: "Not Found" });
    }
    return json(response, 200, { ok: true, method: request.method, path });
  }
  if (url.pathname.startsWith("/github/")) return gitHttpBackend(request, response, body);
  // raw.githubusercontent.com: /<owner>/<repo>/<commit>/<path>
  const raw = /^\/github-raw\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (raw) {
    try {
      const content = NodeChildProcess.execFileSync(
        "git",
        ["-C", NodePath.join(root, raw[1]!, `${raw[2]}.git`), "show", `${raw[3]}:${raw[4]}`],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end(content);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      return response.end("404: Not Found");
    }
  }
  return json(response, 404, { message: "Unknown mock route" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock upstream listening on http://127.0.0.1:${port} (repos in ${root})`);
});

const sharedKeys = (dir = shared): string[] =>
  NodeFS.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sharedKeys(NodePath.join(dir, entry.name))
        : [NodePath.relative(shared, NodePath.join(dir, entry.name))],
    )
    .toSorted();

const xml = (value: string) => value.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** ListObjects (v1 and v2) over the shared directory, in one page. */
function listObjects(url: URL) {
  const prefix = url.searchParams.get("prefix") ?? "";
  const delimiter = url.searchParams.get("delimiter") ?? "";
  const v2 = url.searchParams.get("list-type") === "2";
  const contents: string[] = [];
  const prefixes = new Set<string>();
  for (const key of sharedKeys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const cut = delimiter ? rest.indexOf(delimiter) : -1;
    if (cut !== -1) {
      prefixes.add(prefix + rest.slice(0, cut + delimiter.length));
      continue;
    }
    const stat = NodeFS.statSync(NodePath.join(shared, key));
    contents.push(
      `<Contents><Key>${xml(key)}</Key><LastModified>${stat.mtime.toISOString()}</LastModified>` +
        `<ETag>"${stat.mtimeMs.toString(16)}"</ETag><Size>${stat.size}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`,
    );
  }
  const common = [...prefixes].map(
    (p) => `<CommonPrefixes><Prefix>${xml(p)}</Prefix></CommonPrefixes>`,
  );
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>shared</Name><Prefix>${xml(prefix)}</Prefix>` +
    (v2 ? `<KeyCount>${contents.length + common.length}</KeyCount>` : "<Marker></Marker>") +
    `<MaxKeys>1000</MaxKeys>${delimiter ? `<Delimiter>${xml(delimiter)}</Delimiter>` : ""}` +
    `<IsTruncated>false</IsTruncated>${contents.join("")}${common.join("")}</ListBucketResult>`
  );
}

const s3Server = NodeHttp.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://mock");
  const body = await readBody(request);
  record(request, body, `s3:${request.url}`);
  const xmlResponse = (status: number, value: string) => {
    response.writeHead(status, { "content-type": "application/xml" });
    response.end(value);
  };
  const [, , ...keyParts] = url.pathname.split("/");
  const key = decodeURIComponent(keyParts.join("/"));
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return xmlResponse(
      403,
      "<Error><Code>AccessDenied</Code><Message>read-only mock</Message></Error>",
    );
  }
  if (key === "") {
    if (method === "HEAD") return response.writeHead(200).end();
    if (url.searchParams.has("location")) {
      return xmlResponse(
        200,
        '<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">auto</LocationConstraint>',
      );
    }
    return xmlResponse(200, listObjects(url));
  }
  const file = NodePath.join(shared, key);
  if (
    !file.startsWith(`${shared}/`) ||
    !NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile()
  ) {
    if (method === "HEAD") return response.writeHead(404).end();
    return xmlResponse(404, "<Error><Code>NoSuchKey</Code></Error>");
  }
  const content = NodeFS.readFileSync(file);
  const stat = NodeFS.statSync(file);
  const headers = {
    "content-type": "application/octet-stream",
    "last-modified": stat.mtime.toUTCString(),
    etag: `"${stat.mtimeMs.toString(16)}"`,
    "accept-ranges": "bytes",
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : content.length - 1, content.length - 1);
    const part = content.subarray(start, end + 1);
    response.writeHead(206, {
      ...headers,
      "content-length": part.length,
      "content-range": `bytes ${start}-${end}/${content.length}`,
    });
    return response.end(method === "HEAD" ? undefined : part);
  }
  response.writeHead(200, { ...headers, "content-length": content.length });
  response.end(method === "HEAD" ? undefined : content);
});

s3Server.listen(s3Port, "127.0.0.1", () => {
  console.log(`mock S3 listening on http://127.0.0.1:${s3Port} (shared objects in ${shared})`);
});
