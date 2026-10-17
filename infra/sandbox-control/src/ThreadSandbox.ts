import { DirectoryBackup, type DirectoryBackupRecord, S3Mount } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import { controlPlane, type Env } from "./env.ts";
import { lifecycleVerdict, type ShellThread } from "./lifecycle.ts";
import { directory } from "./SandboxDirectory.ts";
import {
  sandboxProjectId,
  sessionBranchPrefix,
  type RecordedPullRequest,
  type SandboxSession,
} from "./session.ts";
import { sharedMount } from "./sharedMount.ts";
import { bridgeWebSocket } from "./wsBridge.ts";

/** The T3 server in the image listens here (see container/entrypoint.sh). */
const T3_PORT = 3773;
const T3_BIN = ["node", "/opt/t3/dist/bin.mjs"];
const T3_HOME = "/t3home";
const SETTINGS_PATH = `${T3_HOME}/userdata/settings.json`;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/**
 * The entrypoint waits for this boot's token here while the control plane
 * restores the T3 home and mounts the shared bucket.
 */
const PREPARED_MARKER = "/run/t3-sandbox-prepared";
/** A backstop only: the alarm loop polls the T3 server every tick, which keeps it busy. */
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const READY_TIMEOUT_MS = 180_000;
const ACTIVITY_WRITE_INTERVAL_MS = 30_000;
const CHECKPOINT_EVERY_MS = 30 * 60 * 1000;
/** Container snapshots expire after 30 days; older ones are not tried. */
const SNAPSHOT_TTL_MS = 29 * 24 * 60 * 60 * 1000;
/**
 * What the R2 backup leaves out of the T3 home. Worktrees are workspace, which
 * the container snapshot and the session branch carry; caches rebuild.
 */
const BACKUP_EXCLUDE = ["/worktrees/", "/caches/", "/claude/shell-snapshots/", "/claude/skills"];
/** Sizes a sandbox may ask for. One today; the toggle will offer more. */
export const SANDBOX_INSTANCES = ["standard-1"] as const;
export type SandboxInstance = (typeof SANDBOX_INSTANCES)[number];

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
  readonly instance?: SandboxInstance;
}

interface SandboxRecord {
  readonly threadId: string;
  readonly title: string;
  readonly repo: { readonly owner: string; readonly name: string };
  readonly baseBranch: string;
  readonly branchPrefix: string;
  readonly createdAt: string;
  readonly instance: SandboxInstance;
  /** Last view or egress request; checkpoints run only after activity. */
  lastActivityAt: string;
  /** Last `/wake`: a client has the thread open. */
  viewedAt: string;
  pullRequests: RecordedPullRequest[];
  environmentId?: string;
  /** The settings template when this sandbox was created; written on its first boot. */
  readonly settings?: string;
  /** Saved and destroyed; only `/wake` or a create boots it again. */
  asleep?: boolean;
  /** The T3 home (T3's database, settings, Claude's transcripts) in R2. */
  backup?: DirectoryBackupRecord;
  /** The whole disk: the checkout, uncommitted work, installed dependencies. */
  snapshot?: { readonly id: string; readonly image: string; readonly takenAt: string };
  savedAt?: string;
  lastError?: string;
}

/**
 * `starting` covers the container booting, the clone and T3 starting;
 * `restoring` is the T3 home coming back from R2; `saving` precedes `asleep`.
 */
export type SandboxStatus = "asleep" | "starting" | "restoring" | "saving" | "running";

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
  readonly instance: SandboxInstance;
  readonly projectId: string;
  readonly savedAt: string | null;
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
 *
 * It stays awake while its thread has work or someone is viewing it. Then it
 * saves the T3 home to R2 and the disk to a container snapshot, and stops;
 * `/wake` boots it from both. Only deleting the sandbox deletes its saves.
 */
export class ThreadSandbox extends DurableObject<Env> {
  private readonly container: Container;
  private readonly mounts: S3Mount;
  private booting: Promise<string> | null = null;
  /** True once the T3 server in the current container has answered. */
  private t3Ready = false;
  private phase: "restoring" | "saving" | null = null;
  /** settings.json as first read in the current container; changes from it become the template. */
  private settingsBaseline: string | null = null;
  private destroyed = false;
  private lastActivityWrite = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("ThreadSandbox needs a container binding.");
    this.container = ctx.container;
    this.mounts = new S3Mount(ctx.container, controlPlane(ctx).S3Gateway);
    if (this.container.running) {
      // A restarted Durable Object (a deploy, or a dev reload) finds its container
      // still running. Intercepts registered by the previous code would route to
      // stale handlers, so register them again along with the timeout and watcher.
      void ctx.blockConcurrencyWhile(async () => {
        await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
        const record = await this.record();
        if (record) await this.intercept(record);
      });
      this.watch();
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxSummary> {
    const existing = await this.record();
    if (existing) return this.summary(existing);
    const [owner, name, ...extra] = input.repo.split("/");
    if (!owner || !name || extra.length > 0) throw new Error("repo must be owner/name.");
    const instance = input.instance ?? "standard-1";
    if (!SANDBOX_INSTANCES.includes(instance)) throw new Error(`Unknown instance ${instance}.`);
    const now = new Date().toISOString();
    const settings = await directory(controlPlane(this.ctx)).settingsTemplate();
    const record: SandboxRecord = {
      threadId: input.threadId,
      title: input.title ?? input.threadId,
      repo: { owner, name },
      baseBranch: input.baseBranch ?? "main",
      branchPrefix: sessionBranchPrefix(input.threadId),
      createdAt: now,
      instance,
      lastActivityAt: now,
      viewedAt: now,
      pullRequests: [],
      ...(settings ? { settings } : {}),
    };
    await this.save(record);
    // Boot outside this request; callers poll the summary.
    await this.ctx.storage.setAlarm(Date.now());
    return this.summary(record);
  }

  /**
   * The lifecycle loop, every tick while awake: boots a sandbox that is down
   * (first start, or its host restarted), then sleeps or checkpoints it.
   */
  override async alarm(): Promise<void> {
    const record = await this.record();
    if (!record || record.asleep) return;
    try {
      if (!this.t3Ready || !this.container.running) await this.ready();
      else await this.tick(record);
    } catch (error) {
      console.error("sandbox lifecycle failed", String(error));
    }
    const after = await this.record();
    if (after && !after.asleep) {
      await this.ctx.storage.setAlarm(Date.now() + Number(this.env.LIFECYCLE_TICK_MS));
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

  /** Called by the egress entrypoint on every request: the agent is working. */
  async noteActivity(): Promise<void> {
    if (Date.now() - this.lastActivityWrite < ACTIVITY_WRITE_INTERVAL_MS) return;
    this.lastActivityWrite = Date.now();
    const record = await this.record();
    if (!record) return;
    record.lastActivityAt = new Date().toISOString();
    await this.save(record);
  }

  /** A client has the thread open: keeps the sandbox awake, and boots it if it was asleep. */
  async wake(): Promise<SandboxSummary> {
    const record = await this.requireRecord();
    record.viewedAt = new Date().toISOString();
    if (record.asleep) {
      delete record.asleep;
      delete record.lastError;
    }
    await this.save(record);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return this.summary(record);
  }

  /** Saves the sandbox and stops it. Proxied requests get 503 until `/wake`. */
  async sleep(): Promise<SandboxSummary> {
    let record = await this.requireRecord();
    if (record.asleep) return this.summary(record);
    const decidedAt = Date.now();
    if (this.container.running) {
      // A container whose T3 never came up holds nothing worth more than the last saves.
      if (this.t3Ready) {
        this.phase = "saving";
        await this.save(record);
        try {
          record = await this.checkpoint(record);
        } finally {
          this.phase = null;
        }
        // Opened while saving: stay awake; the save still counts as a checkpoint.
        if (Date.parse(record.viewedAt) > decidedAt) {
          await this.save(record);
          return this.summary(record);
        }
      }
      await this.container.destroy("asleep");
    }
    this.booting = null;
    this.t3Ready = false;
    record.asleep = true;
    await this.save(record);
    return this.summary(record);
  }

  async destroy(): Promise<void> {
    const record = await this.record();
    this.destroyed = true;
    if (this.container.running) await this.container.destroy("deleted");
    this.booting = null;
    this.t3Ready = false;
    if (record) {
      // Every object under this sandbox's prefix, including any a crash left unrecorded.
      const listed = await this.env.BACKUPS.list({ prefix: backupPrefix(record) });
      if (listed.objects.length > 0) {
        await this.env.BACKUPS.delete(listed.objects.map((object) => object.key));
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (record) await directory(controlPlane(this.ctx)).remove(record.threadId);
  }

  /**
   * Development only (gated by DEBUG_EXEC): the next boot ignores the snapshot,
   * as when it has expired, so proofs can exercise the fallback.
   */
  async forgetSnapshot(): Promise<void> {
    const record = await this.requireRecord();
    delete record.snapshot;
    await this.save(record);
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

  /**
   * Proxies a client request into the sandbox's T3 server with the sandbox
   * credential. An asleep sandbox answers 503 without waking: clients ping
   * every environment they know, so only `/wake` may boot one.
   */
  override async fetch(request: Request): Promise<Response> {
    if ((await this.record())?.asleep) {
      return Response.json({ status: "asleep" }, { status: 503 });
    }
    let token: string;
    try {
      token = await this.ready();
    } catch (error) {
      return new Response(`The sandbox did not start: ${String(error)}\n`, { status: 503 });
    }
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // The browser's Access session is for the control plane, never the agent.
    for (const name of [...headers.keys()]) {
      if (name === "cookie" || name.startsWith("cf-access-")) headers.delete(name);
    }
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
    try {
      const response = await this.container.getTcpPort(T3_PORT).fetch(upstream);
      if (response.webSocket) return bridgeWebSocket(response.webSocket);
      // Every sandbox shares the control plane's origin, so none may set cookies on it.
      if (!response.headers.has("set-cookie")) return response;
      const proxied = new Response(response.body, response);
      proxied.headers.delete("set-cookie");
      return proxied;
    } catch (error) {
      return new Response(`The sandbox is not responding: ${String(error)}\n`, { status: 502 });
    }
  }

  private async tick(record: SandboxRecord) {
    const token = await this.ctx.storage.get<string>("t3Token");
    if (!token) return;
    const shell = await this.t3Json<{ threads: ShellThread[] }>("/api/orchestration/shell", token);
    const verdict = lifecycleVerdict({
      threads: shell.threads,
      viewedAt: Date.parse(record.viewedAt),
      activeAt: Date.parse(record.lastActivityAt),
      savedAt: Date.parse(record.savedAt ?? record.createdAt),
      now: Date.now(),
      sleepAfterMs: Number(this.env.SLEEP_AFTER_MS),
      checkpointEveryMs: CHECKPOINT_EVERY_MS,
    });
    if (verdict === "sleep") {
      await this.sleep();
      return;
    }
    await this.captureSettings();
    if (verdict === "checkpoint") await this.checkpoint(record);
  }

  /**
   * Settings edited in this sandbox, from any client or by an agent, become the
   * template new sandboxes start with. Sandboxes that exist keep their own.
   */
  private async captureSettings() {
    const output = await (await this.container.exec(["cat", SETTINGS_PATH])).output();
    if (output.exitCode !== 0) return;
    const current = new TextDecoder().decode(output.stdout);
    try {
      JSON.parse(current);
    } catch {
      return; // Read mid-write; the next tick sees the whole file.
    }
    const baseline = this.settingsBaseline;
    this.settingsBaseline = current;
    if (baseline !== null && current !== baseline) {
      await directory(controlPlane(this.ctx)).setSettingsTemplate(current);
    }
  }

  /**
   * Saves the T3 home to R2, then the disk as a container snapshot. The T3
   * server keeps running, so a checkpoint is crash-consistent, not quiesced.
   */
  private async checkpoint(record: SandboxRecord): Promise<SandboxRecord> {
    const backups = this.backups(record);
    const backup = await backups.backup({
      dir: T3_HOME,
      name: record.threadId,
      exclude: BACKUP_EXCLUDE,
    });
    let fresh = await this.requireRecord();
    const previous = fresh.backup;
    fresh.backup = backup;
    fresh.savedAt = new Date().toISOString();
    await this.save(fresh);
    if (previous) {
      await backups
        .delete(previous)
        .catch((error: unknown) => console.warn("deleting a backup failed", String(error)));
    }
    const snapshot = await this.container.snapshotContainer({ name: record.threadId });
    fresh = await this.requireRecord();
    fresh.snapshot = { id: snapshot.id, image: this.image(), takenAt: new Date().toISOString() };
    await this.save(fresh);
    return fresh;
  }

  /** Starts the container if needed and resolves with the T3 bearer token once T3 answers. */
  private ready(): Promise<string> {
    if (this.booting && this.container.running) return this.booting;
    this.booting = this.boot().catch(async (error: unknown) => {
      this.booting = null;
      this.t3Ready = false;
      // The next attempt starts clean rather than finding a half-booted container.
      if (this.container.running) await this.container.destroy("boot failed").catch(() => {});
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
    if (record.asleep) throw new Error("The sandbox is asleep.");
    const startedHere = !this.container.running;
    if (startedHere) {
      this.t3Ready = false;
      this.settingsBaseline = null;
      const snapshot = this.usableSnapshot(record);
      const preparedToken = randomId();
      await this.intercept(record);
      this.container.start({
        ...(snapshot ? { containerSnapshot: { id: snapshot } } : { image: this.image() }),
        enableInternet: false,
        instance: record.instance,
        env: {
          ...this.sandboxEnv(record),
          T3_SANDBOX_PREPARED: preparedToken,
          ...(!record.backup && record.settings ? { T3_SANDBOX_SETTINGS: record.settings } : {}),
        },
        labels: { thread: record.threadId.slice(0, 64) },
      });
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      this.watch();
      if (record.backup) {
        this.phase = "restoring";
        await this.save(record);
      }
      try {
        await this.untilExecutable().catch(async (error: unknown) => {
          // A snapshot past its TTL or from a replaced image does not start;
          // the next boot uses the image, the R2 backup and the session branch.
          if (snapshot) {
            delete record.snapshot;
            await this.save(record);
          }
          throw error;
        });
        if (record.backup) await this.restoreHome(record, record.backup);
        await this.mountShared();
        await this.run(["sh", "-c", `printf %s "$0" > ${PREPARED_MARKER}`, preparedToken]);
      } finally {
        this.phase = null;
      }
      delete record.lastError;
      await this.save(record);
    }

    const descriptor = await this.waitForT3();
    let token = await this.ctx.storage.get<string>("t3Token");
    if (startedHere || !token) {
      token = await this.issueToken();
      await this.ctx.storage.put("t3Token", token);
    }
    await this.ensureProject(record, token);
    record.environmentId = descriptor.environmentId;
    this.t3Ready = true;
    await this.save(record);
    return token;
  }

  /**
   * Puts the T3 home back while the entrypoint waits. Restoring over a
   * directory the image or snapshot holds fails on an overlay root (EXDEV), so
   * the old copy goes first; T3 has not started, so nothing holds it open.
   */
  private async restoreHome(record: SandboxRecord, backup: DirectoryBackupRecord) {
    await this.run(["rm", "-rf", T3_HOME]);
    await this.backups(record).restore(backup, { dir: T3_HOME });
  }

  /**
   * The shared bucket at /shared, for the entrypoint to hand to Claude. The
   * Worker signs its requests, so the keys never enter the sandbox. A failed
   * mount leaves the sandbox without it rather than down.
   */
  private async mountShared() {
    const mount = sharedMount(this.env);
    if (!mount) return;
    await this.mounts.mount(mount).catch((error: unknown) => {
      console.error("mounting the shared bucket failed", String(error));
    });
  }

  /**
   * The checkout's project, created once with an id derived from the repo, so
   * T3 never bootstraps one with an empty thread and a new sandbox for the same
   * repo gets the same project id.
   */
  private async ensureProject(record: SandboxRecord, token: string) {
    const projectId = sandboxProjectId(record.repo);
    const shell = await this.t3Json<{ projects: Array<{ id: string }> }>(
      "/api/orchestration/shell",
      token,
    );
    if (shell.projects.some((project) => project.id === projectId)) return;
    const response = await this.t3Fetch("/api/projects/mutate", token, {
      method: "POST",
      body: JSON.stringify({
        type: "project.create",
        commandId: randomId(),
        projectId,
        title: record.repo.name,
        workspaceRoot: `/workspace/${record.repo.name}`,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Creating the project failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
  }

  /**
   * Routes every HTTP(S) request from the container through the egress
   * entrypoint, bound to this thread. With internet off, nothing else leaves.
   * Backup traffic is routed first: the catch-all takes every hostname
   * registered after it.
   */
  private async intercept(record: SandboxRecord) {
    await this.backups(record).intercept();
    const egress = controlPlane(this.ctx).Egress({ props: { threadId: record.threadId } });
    await this.container.interceptOutboundHttps("*", egress);
    await this.container.interceptAllOutboundHttp(egress);
  }

  private backups(record: SandboxRecord) {
    return new DirectoryBackup(this.container, controlPlane(this.ctx).DirectoryBackupGateway, {
      binding: "BACKUPS",
      prefix: backupPrefix(record),
    });
  }

  private image() {
    return this.container.images.t3!;
  }

  private usableSnapshot(record: SandboxRecord) {
    const snapshot = record.snapshot;
    if (!snapshot || snapshot.image !== this.image()) return null;
    return Date.now() - Date.parse(snapshot.takenAt) < SNAPSHOT_TTL_MS ? snapshot.id : null;
  }

  private async untilExecutable() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        await this.run(["true"]);
        return;
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`The container did not start: ${String(error)}`);
      }
      await scheduler.wait(500);
    }
  }

  private async run(argv: string[]) {
    const output = await (await this.container.exec(argv)).output();
    if (output.exitCode !== 0) {
      throw new Error(`${argv[0]} failed: ${new TextDecoder().decode(output.stderr)}`);
    }
  }

  private t3Fetch(path: string, token: string, init: RequestInit = {}) {
    return this.container.getTcpPort(T3_PORT).fetch(`http://container${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-t3-orchestration-protocol": "2",
      },
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async t3Json<T>(path: string, token: string): Promise<T> {
    const response = await this.t3Fetch(path, token);
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
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
      // Claude's transcripts live in the T3 home, so the R2 backup carries them.
      CLAUDE_CONFIG_DIR: `${T3_HOME}/claude`,
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

  private record() {
    return this.ctx.storage.get<SandboxRecord>("record");
  }

  private async requireRecord() {
    const record = await this.record();
    if (!record) throw new Error("No sandbox exists for this thread.");
    return record;
  }

  private async save(record: SandboxRecord) {
    // A checkpoint or watcher finishing after deletion must not bring the record back.
    if (this.destroyed) return;
    await this.ctx.storage.put("record", record);
    await directory(controlPlane(this.ctx)).upsert(this.summary(record));
  }

  private status(record: SandboxRecord): SandboxStatus {
    if (record.asleep) return "asleep";
    if (this.phase) return this.phase;
    return this.t3Ready && this.container.running ? "running" : "starting";
  }

  private summary(record: SandboxRecord): SandboxSummary {
    return {
      threadId: record.threadId,
      title: record.title,
      status: this.status(record),
      repo: `${record.repo.owner}/${record.repo.name}`,
      baseBranch: record.baseBranch,
      branchPrefix: record.branchPrefix,
      pullRequests: record.pullRequests,
      environmentId: record.environmentId ?? null,
      instance: record.instance,
      projectId: sandboxProjectId(record.repo),
      savedAt: record.savedAt ?? null,
      lastActivityAt: record.lastActivityAt,
      lastError: record.lastError ?? null,
    };
  }
}

const backupPrefix = (record: SandboxRecord) => `${record.threadId}/`;

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
