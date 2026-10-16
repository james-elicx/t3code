import { DurableObject } from "cloudflare:workers";

import type { ControlPlaneExports, Env } from "./env.ts";
import { directory } from "./SandboxDirectory.ts";
import { sessionBranchPrefix, type RecordedPullRequest, type SandboxSession } from "./session.ts";
import { bridgeWebSocket } from "./wsBridge.ts";

/** The T3 server in the image listens here (see container/entrypoint.sh). */
const T3_PORT = 3773;
const T3_BIN = ["node", "/opt/t3/dist/bin.mjs"];
const T3_HOME = "/t3home";
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const READY_TIMEOUT_MS = 180_000;
const ACTIVITY_WRITE_INTERVAL_MS = 30_000;

/**
 * Stand-ins the sandbox holds instead of credentials. Tools see a key and use
 * it; the egress entrypoint drops it and adds the real credential outside.
 */
export const SANDBOX_PLACEHOLDER_ENV = {
  ANTHROPIC_API_KEY: "sk-ant-sandbox-placeholder",
  GH_TOKEN: "github-sandbox-placeholder",
} as const;

export interface CreateSandboxInput {
  readonly threadId: string;
  /** `owner/name` on GitHub; the sandbox may push only its own branches there. */
  readonly repo: string;
  readonly baseBranch?: string;
  readonly title?: string;
}

interface SandboxRecord {
  readonly threadId: string;
  readonly title: string;
  readonly repo: { readonly owner: string; readonly name: string };
  readonly baseBranch: string;
  readonly branchPrefix: string;
  readonly createdAt: string;
  lastActivityAt: string;
  pullRequests: RecordedPullRequest[];
  environmentId?: string;
  snapshotId?: string;
  /** Set by restore(): the next start boots from this snapshot instead of the image. */
  restoreFrom?: string;
  lastError?: string;
}

export type SandboxStatus = "stopped" | "starting" | "running";

/** What the directory shows for a sandbox without waking it. */
export interface SandboxSummary {
  readonly threadId: string;
  readonly title: string;
  readonly status: SandboxStatus;
  readonly repo: string;
  readonly baseBranch: string;
  readonly branchPrefix: string;
  readonly pullRequests: ReadonlyArray<RecordedPullRequest>;
  readonly environmentId: string | null;
  readonly snapshotId: string | null;
  readonly lastActivityAt: string;
  readonly lastError: string | null;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One thread's sandbox: its session record, its container running a T3 server
 * that holds this one thread, and the proxy into it. Clients never see the T3
 * credential; this object adds it to every proxied request.
 */
export class ThreadSandbox extends DurableObject<Env> {
  private readonly container: Container;
  private booting: Promise<string> | null = null;
  /** True once the T3 server in the current container has answered. */
  private t3Ready = false;
  private lastActivityWrite = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("ThreadSandbox needs a container binding.");
    this.container = ctx.container;
    if (this.container.running) {
      // A restarted Durable Object (a deploy, or a dev reload) finds its container
      // still running. Intercepts registered by the previous code would route to
      // stale handlers, so register them again along with the timeout and watcher.
      void ctx.blockConcurrencyWhile(async () => {
        await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
        const record = await this.record();
        if (record) await this.interceptEgress(record.threadId);
      });
      this.watch();
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxSummary> {
    const existing = await this.record();
    if (existing) return this.summary(existing);
    const [owner, name, ...extra] = input.repo.split("/");
    if (!owner || !name || extra.length > 0) throw new Error("repo must be owner/name.");
    const now = new Date().toISOString();
    const record: SandboxRecord = {
      threadId: input.threadId,
      title: input.title ?? input.threadId,
      repo: { owner, name },
      baseBranch: input.baseBranch ?? "main",
      branchPrefix: sessionBranchPrefix(input.threadId),
      createdAt: now,
      lastActivityAt: now,
      pullRequests: [],
    };
    await this.save(record);
    // Boot outside this request; callers poll the summary.
    await this.ctx.storage.setAlarm(Date.now());
    return this.summary(record);
  }

  override async alarm(): Promise<void> {
    try {
      await this.ready();
    } catch (error) {
      console.error("sandbox boot failed", error);
    }
  }

  async describe(): Promise<SandboxSummary | null> {
    const record = await this.record();
    return record ? this.summary(record) : null;
  }

  async session(): Promise<SandboxSession | null> {
    const record = await this.record();
    if (!record) return null;
    return {
      threadId: record.threadId,
      repo: record.repo,
      baseBranch: record.baseBranch,
      branchPrefix: record.branchPrefix,
      pullRequests: record.pullRequests,
    };
  }

  /** Called by the egress entrypoint when this sandbox opens a pull request. */
  async recordPullRequest(pullRequest: RecordedPullRequest): Promise<void> {
    const record = await this.requireRecord();
    if (record.pullRequests.some((existing) => existing.number === pullRequest.number)) return;
    record.pullRequests.push(pullRequest);
    await this.save(record);
  }

  /** Saves the container's root filesystem, including the T3 home and the checkout. */
  async snapshot(): Promise<{ id: string; size: number }> {
    const record = await this.requireRecord();
    if (!this.container.running) throw new Error("The sandbox is not running.");
    const snapshot = await this.container.snapshotContainer({ name: record.threadId });
    record.snapshotId = snapshot.id;
    await this.save(record);
    return { id: snapshot.id, size: snapshot.size };
  }

  async stop(): Promise<void> {
    if (this.container.running) await this.container.destroy("stopped by control plane");
    this.booting = null;
    this.t3Ready = false;
    const record = await this.record();
    if (record) await this.save(record);
  }

  /** Restarts the sandbox from its last snapshot. */
  async restore(): Promise<SandboxSummary> {
    const record = await this.requireRecord();
    if (!record.snapshotId) throw new Error("This sandbox has no snapshot.");
    await this.stop();
    record.restoreFrom = record.snapshotId;
    await this.save(record);
    await this.ctx.storage.setAlarm(Date.now());
    return this.summary(record);
  }

  async destroy(): Promise<void> {
    const record = await this.record();
    await this.stop();
    await this.ctx.storage.deleteAll();
    if (record) await directory(this.env).remove(record.threadId);
  }

  /** Development only (gated by DEBUG_EXEC in the Worker): runs a command in the sandbox. */
  async exec(argv: string[], options: { env?: Record<string, string>; cwd?: string } = {}) {
    const record = await this.requireRecord();
    await this.ready();
    const process = await this.container.exec(argv, {
      env: { ...this.sandboxEnv(record), ...options.env },
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    } satisfies ExecResult;
  }

  /** Proxies a client request into the sandbox's T3 server with the sandbox credential. */
  override async fetch(request: Request): Promise<Response> {
    let token: string;
    try {
      token = await this.ready();
    } catch (error) {
      return new Response(`The sandbox did not start: ${String(error)}\n`, { status: 503 });
    }
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));
    // The runtime otherwise asks for br/gzip and hands the encoded body to a client that did not.
    if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
    const upstream = new Request(`http://container${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
    const touch = () => this.ctx.waitUntil(this.touch());
    touch();
    try {
      const response = await this.container.getTcpPort(T3_PORT).fetch(upstream);
      return response.webSocket ? bridgeWebSocket(response.webSocket, touch) : response;
    } catch (error) {
      return new Response(`The sandbox is not responding: ${String(error)}\n`, { status: 502 });
    }
  }

  /** Starts the container if needed and resolves with the T3 bearer token once T3 answers. */
  private ready(): Promise<string> {
    if (this.booting && this.container.running) return this.booting;
    this.booting = this.boot().catch(async (error: unknown) => {
      this.booting = null;
      this.t3Ready = false;
      const record = await this.record();
      if (record) {
        record.lastError = String(error);
        await this.save(record);
      }
      throw error;
    });
    return this.booting;
  }

  private async boot(): Promise<string> {
    const record = await this.requireRecord();
    const startedHere = !this.container.running;
    if (startedHere) {
      await this.interceptEgress(record.threadId);
      const source = record.restoreFrom
        ? { containerSnapshot: { id: record.restoreFrom } }
        : { image: this.container.images.t3! };
      this.container.start({
        ...source,
        enableInternet: false,
        instance: "standard-1",
        env: this.sandboxEnv(record),
        labels: { thread: record.threadId.slice(0, 64) },
      });
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      this.watch();
      delete record.restoreFrom;
      delete record.lastError;
      await this.save(record);
    }

    const descriptor = await this.waitForT3();
    let token = await this.ctx.storage.get<string>("t3Token");
    if (startedHere || !token) {
      token = await this.issueToken();
      await this.ctx.storage.put("t3Token", token);
    }
    record.environmentId = descriptor.environmentId;
    this.t3Ready = true;
    await this.save(record);
    return token;
  }

  /**
   * Routes every HTTP(S) request from the container through the egress
   * entrypoint, bound to this thread. With internet off, nothing else leaves.
   */
  private async interceptEgress(threadId: string) {
    const egress = (this.ctx.exports as unknown as ControlPlaneExports).Egress({
      props: { threadId },
    });
    await this.container.interceptOutboundHttps("*", egress);
    await this.container.interceptAllOutboundHttp(egress);
  }

  private async waitForT3(): Promise<{ environmentId: string }> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await this.container
          .getTcpPort(T3_PORT)
          .fetch("http://container/.well-known/t3/environment", {
            signal: AbortSignal.timeout(2_000),
          });
        if (response.ok) return (await response.json()) as { environmentId: string };
        lastError = `HTTP ${response.status}`;
        await response.body?.cancel();
      } catch (error) {
        lastError = error;
      }
      if (!this.container.running) throw new Error("The container exited during startup.");
      await scheduler.wait(1_000);
    }
    throw new Error(`T3 did not answer within ${READY_TIMEOUT_MS / 1000}s: ${String(lastError)}`);
  }

  /** Mints the bearer token this object injects; it never leaves the control plane. */
  private async issueToken(): Promise<string> {
    const process = await this.container.exec(
      [
        ...T3_BIN,
        "auth",
        "session",
        "issue",
        "--base-dir",
        T3_HOME,
        "--label",
        "T3 sandbox control plane",
        "--token-only",
      ],
      { env: { T3CODE_HOME: T3_HOME } },
    );
    const output = await process.output();
    const decoder = new TextDecoder();
    const token = decoder.decode(output.stdout).trim();
    if (output.exitCode !== 0 || token.length === 0) {
      throw new Error(`Issuing the T3 token failed: ${decoder.decode(output.stderr)}`);
    }
    return token;
  }

  private sandboxEnv(record: SandboxRecord): Record<string, string> {
    return {
      ...SANDBOX_PLACEHOLDER_ENV,
      T3CODE_HOME: T3_HOME,
      T3_SANDBOX_THREAD_ID: record.threadId,
      T3_SANDBOX_REPO: `${record.repo.owner}/${record.repo.name}`,
      T3_SANDBOX_BRANCH: `${record.branchPrefix}work`,
      // The intercept terminates TLS with a per-instance CA; trust it explicitly too.
      NODE_EXTRA_CA_CERTS: CA_PATH,
      GIT_TERMINAL_PROMPT: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      // The container is the sandbox; Claude refuses to skip permissions as root otherwise.
      IS_SANDBOX: "1",
    };
  }

  private watch() {
    this.ctx.waitUntil(
      this.container
        .monitor()
        .catch((error: unknown) => console.warn("sandbox container stopped", String(error)))
        .then(async () => {
          this.booting = null;
          this.t3Ready = false;
          const record = await this.record();
          if (record) await this.save(record);
        }),
    );
  }

  private async touch() {
    if (Date.now() - this.lastActivityWrite < ACTIVITY_WRITE_INTERVAL_MS) return;
    this.lastActivityWrite = Date.now();
    const record = await this.record();
    if (!record) return;
    record.lastActivityAt = new Date().toISOString();
    await this.save(record);
  }

  private record() {
    return this.ctx.storage.get<SandboxRecord>("record");
  }

  private async requireRecord() {
    const record = await this.record();
    if (!record) throw new Error("No sandbox exists for this thread.");
    return record;
  }

  private async save(record: SandboxRecord) {
    await this.ctx.storage.put("record", record);
    await directory(this.env).upsert(this.summary(record));
  }

  private summary(record: SandboxRecord): SandboxSummary {
    return {
      threadId: record.threadId,
      title: record.title,
      status: !this.container.running ? "stopped" : this.t3Ready ? "running" : "starting",
      repo: `${record.repo.owner}/${record.repo.name}`,
      baseBranch: record.baseBranch,
      branchPrefix: record.branchPrefix,
      pullRequests: record.pullRequests,
      environmentId: record.environmentId ?? null,
      snapshotId: record.snapshotId ?? null,
      lastActivityAt: record.lastActivityAt,
      lastError: record.lastError ?? null,
    };
  }
}
