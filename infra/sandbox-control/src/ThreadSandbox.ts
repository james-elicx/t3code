import { DirectoryBackup, type DirectoryBackupRecord, S3Mount } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import {
  DEPS_BUILD_TIMEOUT_MS,
  DEPS_CACHE_DIR,
  DEPS_RESTORED_MARKER,
  DEPS_STATUS_PATH,
  depsPrefix,
  TOOLCHAIN_PATH,
  type DepsCache,
} from "./depsCache.ts";
import { controlPlane, type Env } from "./env.ts";
import { lifecycleVerdict, type ShellThread } from "./lifecycle.ts";
import {
  launchRequest,
  parseRepo,
  projectConfigOf,
  sameConfig,
  type Json,
  type ProjectConfig,
  type SandboxLaunch,
} from "./projects.ts";
import { directory } from "./SandboxDirectory.ts";
import {
  sandboxProjectId,
  sessionBranchPrefix,
  type RecordedPullRequest,
  type SandboxSession,
} from "./session.ts";
import { sameSettings } from "./settings.ts";
import { sharedMount } from "./sharedMount.ts";
import { bridgeWebSocket } from "./wsBridge.ts";

/** The T3 server in the image listens here (see container/entrypoint.sh). */
const T3_PORT = 3773;
const T3_BIN = ["node", "/opt/t3/dist/bin.mjs"];
const T3_HOME = "/t3home";
const SETTINGS_PATH = `${T3_HOME}/userdata/settings.json`;
/** settings.json as this sandbox last saved it to the template, or as it booted with. */
const SETTINGS_BASELINE_KEY = "settingsBaseline";

const warnCaptureFailed = (error: unknown) =>
  console.warn("capturing settings failed", String(error));

const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/**
 * The entrypoint waits for this boot's token here while the control plane
 * restores the T3 home and mounts the shared bucket.
 */
const PREPARED_MARKER = "/run/t3-sandbox-prepared";
/** The control plane writes the same token here once T3 answers; the entrypoint's background work waits for it. */
const ANSWERED_MARKER = "/run/t3-sandbox-answered";
/** Where the entrypoint marks when each of its steps finished. */
const TIMING_PATH = "/run/t3-sandbox-timing";

/** Each boot step's duration in ms, for the boot log. */
function bootTiming() {
  let last = Date.now();
  const steps: Record<string, number> = {};
  return {
    mark(step: string) {
      const now = Date.now();
      steps[step] = now - last;
      last = now;
    },
    steps: () => steps,
  };
}
/** A backstop only: the alarm loop polls the T3 server every tick, which keeps it busy. */
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
/** How often a dependency cache builder looks at its install. */
const DEPS_BUILD_TICK_MS = 10_000;
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
/**
 * Sizes a sandbox may ask for; the first is the default. One today; the toggle
 * will offer more. Half a vCPU (standard-1) made T3, Claude Code and git crawl.
 */
export const SANDBOX_INSTANCES = ["standard-2"] as const;
export type SandboxInstance = (typeof SANDBOX_INSTANCES)[number];
const DEFAULT_INSTANCE: SandboxInstance = SANDBOX_INSTANCES[0];

/** A sandbox's size: one recorded on a size no longer offered boots on the default. */
function instanceOf(record: SandboxRecord): SandboxInstance {
  return SANDBOX_INSTANCES.includes(record.instance) ? record.instance : DEFAULT_INSTANCE;
}

/**
 * Stand-ins the sandbox holds instead of credentials. Tools see a key and use
 * it; the egress entrypoint drops it and adds the real credential outside.
 */
export const SANDBOX_PLACEHOLDER_ENV = {
  ANTHROPIC_API_KEY: "sk-ant-sandbox-placeholder",
  GH_TOKEN: "github-sandbox-placeholder",
} as const;

export interface AllocateSandboxInput {
  readonly threadId: string;
  /** `owner/name` on GitHub; the sandbox may push only its own branches there. */
  readonly repo: string;
  readonly baseBranch?: string;
}

export interface StartSandboxInput {
  readonly title?: string;
  readonly instance?: SandboxInstance;
  /** The thread to start in it, launched before any client connects. */
  readonly launch?: SandboxLaunch;
}

export type CreateSandboxInput = AllocateSandboxInput & StartSandboxInput;

/** A first boot: the container starting, the clone and T3 starting, then the thread's launch. */
export type SetupStep = "container" | "clone" | "launch";

/** What clients show for a sandbox's thread before its T3 server first answers. */
export interface PendingThread {
  readonly threadId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly modelSelection: Json;
  readonly runtimeMode: string;
  readonly interactionMode: string;
}

/** The one RPC message `readServerConfig` reads; others it skips. */
interface RpcExit {
  readonly _tag: string;
  readonly requestId?: string;
  readonly exit: { readonly _tag: string; readonly value?: unknown };
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
  /** Chosen when the record is made, so clients know the environment before it runs. */
  environmentId?: string;
  /** A project's next sandbox: listed, with no container until a thread starts it. */
  unstarted?: boolean;
  /** The thread its first boot launches, and when that launch went through. */
  launch?: SandboxLaunch;
  launchedAt?: string;
  /** When its T3 server first answered. */
  ranAt?: string;
  /** The settings template when this sandbox was created; written on its first boot. */
  readonly settings?: string;
  /** Saved and destroyed; only `/wake` or a create boots it again. */
  asleep?: boolean;
  /** Boots once without a repository to read the server config, then deletes itself. */
  probe?: boolean;
  /** Builds its project's dependency cache from the default branch, then deletes itself. */
  depsBuild?: { startedAt?: string };
  /** The T3 home (T3's database, settings, Claude's transcripts) in R2. */
  backup?: DirectoryBackupRecord;
  /** The whole disk: the checkout, uncommitted work, installed dependencies. */
  snapshot?: { readonly id: string; readonly image: string; readonly takenAt: string };
  savedAt?: string;
  lastError?: string;
}

/**
 * `unstarted` is a project's next sandbox; `starting` covers the container
 * booting, the clone and T3 starting; `restoring` is the T3 home coming back
 * from R2; `saving` precedes `asleep`.
 */
export type SandboxStatus =
  | "unstarted"
  | "asleep"
  | "starting"
  | "restoring"
  | "saving"
  | "running";

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
  readonly ranAt: string | null;
  /** Where a sandbox that has never run is in its first boot. */
  readonly setupStep: SetupStep | null;
  /** Its first thread, until the T3 server has it. */
  readonly pendingThread: PendingThread | null;
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
  /** Where a first boot is, for the client's setup card. */
  private step: SetupStep | null = null;
  /** settings.json when T3 came up in this container; changes from it become the template. */
  /** The project's config when T3 came up; changes from it carry to later sandboxes. */
  private projectBaseline: ProjectConfig | null = null;
  private destroyed = false;
  private lastActivityWrite = 0;
  /** Backups and restores, one at a time: each holds the container's one backup grant. */
  private transfers: Promise<unknown> = Promise.resolve();

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

  /**
   * Makes the record without a container: a project's next sandbox. Its
   * environment id is fixed now, so clients can list the project before
   * anything runs.
   */
  async allocate(input: AllocateSandboxInput): Promise<SandboxSummary> {
    const existing = await this.record();
    if (existing) return this.summary(existing);
    const { owner, name } = parseRepo(input.repo);
    const now = new Date().toISOString();
    const record: SandboxRecord = {
      threadId: input.threadId,
      title: `${owner}/${name}`,
      repo: { owner, name },
      baseBranch: input.baseBranch ?? "main",
      branchPrefix: sessionBranchPrefix(input.threadId),
      createdAt: now,
      instance: DEFAULT_INSTANCE,
      lastActivityAt: now,
      viewedAt: now,
      pullRequests: [],
      environmentId: randomUuid(),
      unstarted: true,
    };
    await this.save(record);
    return this.summary(record);
  }

  /** Boots an unstarted sandbox, with the thread its first message starts. */
  async start(input: StartSandboxInput): Promise<SandboxSummary> {
    const record = await this.requireRecord();
    if (!record.unstarted) return this.summary(record);
    // An unstarted sandbox's size is only the default it was allocated with.
    const instance = input.instance ?? DEFAULT_INSTANCE;
    if (!SANDBOX_INSTANCES.includes(instance)) throw new Error(`Unknown instance ${instance}.`);
    const plane = directory(controlPlane(this.ctx));
    await plane.captureRunningSettings();
    const settings = await plane.settingsTemplate();
    const now = new Date().toISOString();
    const started: SandboxRecord = {
      ...record,
      title: input.title ?? input.launch?.title ?? record.title,
      instance,
      lastActivityAt: now,
      viewedAt: now,
      ...(settings ? { settings } : {}),
      ...(input.launch ? { launch: input.launch } : {}),
    };
    delete started.unstarted;
    await this.save(started);
    // Boot outside this request; callers poll the summary.
    await this.ctx.storage.setAlarm(Date.now());
    await plane.slotStarted(`${record.repo.owner}/${record.repo.name}`);
    return this.summary(started);
  }

  /** See `SandboxDirectory.ensureServerConfig`. Unlisted; boots from the alarm. */
  async probe(id: string): Promise<void> {
    if (await this.record()) return;
    const now = new Date().toISOString();
    const settings = await directory(controlPlane(this.ctx)).settingsTemplate();
    await this.save({
      threadId: id,
      title: "Server config probe",
      repo: { owner: "t3", name: "probe" },
      baseBranch: "main",
      branchPrefix: sessionBranchPrefix(id),
      createdAt: now,
      instance: DEFAULT_INSTANCE,
      lastActivityAt: now,
      viewedAt: now,
      pullRequests: [],
      probe: true,
      ...(settings ? { settings } : {}),
    });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** See `SandboxDirectory.checkDeps`. Unlisted; builds from the alarm, then deletes itself. */
  async buildDeps(id: string, repo: string): Promise<void> {
    if (await this.record()) return;
    const { owner, name } = parseRepo(repo);
    const now = new Date().toISOString();
    await this.save({
      threadId: id,
      title: `Dependency cache for ${owner}/${name}`,
      repo: { owner, name },
      baseBranch: "main",
      branchPrefix: sessionBranchPrefix(id),
      createdAt: now,
      instance: DEFAULT_INSTANCE,
      lastActivityAt: now,
      viewedAt: now,
      pullRequests: [],
      depsBuild: {},
    });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async create(input: CreateSandboxInput): Promise<SandboxSummary> {
    const existing = await this.record();
    if (existing && !existing.unstarted) return this.summary(existing);
    if (!existing) await this.allocate(input);
    return this.start(input);
  }

  /**
   * The lifecycle loop, every tick while awake: boots a sandbox that is down
   * (first start, or its host restarted), then sleeps or checkpoints it.
   */
  override async alarm(): Promise<void> {
    const record = await this.record();
    if (!record || record.asleep || record.unstarted) return;
    if (record.depsBuild) {
      await this.buildDepsTick(record).catch(async (error: unknown) => {
        await directory(controlPlane(this.ctx)).depsBuildFailed(repoName(record), String(error));
        await this.destroy();
      });
      if (await this.record()) await this.ctx.storage.setAlarm(Date.now() + DEPS_BUILD_TICK_MS);
      return;
    }
    if (record.probe) {
      // The boot stores the server config.
      await this.ready().catch((error: unknown) =>
        console.error("probing the server config failed", String(error)),
      );
      await this.destroy();
      return;
    }
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

  /** Null for a sandbox the control plane runs for itself, which nobody may reach. */
  async describe(): Promise<SandboxSummary | null> {
    const record = await this.record();
    return record && !unlisted(record) ? this.summary(record) : null;
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
    // A deleted sandbox's container that the runtime restarted after its delete.
    if (!record) return this.destroyContainer("deleted");
    record.lastActivityAt = new Date().toISOString();
    await this.save(record);
  }

  /** A client has the thread open: keeps the sandbox awake, and boots it if it was asleep. */
  async wake(): Promise<SandboxSummary> {
    const record = await this.requireRecord();
    // Only a thread's first message starts a project's next sandbox.
    if (record.unstarted) return this.summary(record);
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
        await this.captureSettingsNow().catch(warnCaptureFailed);
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
    // Settings edited since the last tick still become the template.
    if (record && !unlisted(record)) await this.captureSettingsNow().catch(warnCaptureFailed);
    this.destroyed = true;
    await this.destroyContainer("deleted");
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
    const record = await this.record();
    if (record?.asleep || record?.unstarted) {
      return Response.json({ status: this.status(record) }, { status: 503 });
    }
    // Booting takes a while; clients retry rather than hold a request open for it.
    // A container already running (a restarted object) is only being reattached.
    if (record && !this.t3Ready && (this.booting || !this.container.running)) {
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ status: this.status(record) }, { status: 503 });
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
    const shell = await this.t3Json<{ threads: ShellThread[]; projects?: ShellProject[] }>(
      "/api/orchestration/shell",
      token,
    );
    const verdict = lifecycleVerdict({
      threads: shell.threads,
      threadId: record.launch && record.launchedAt ? record.launch.threadId : null,
      viewedAt: Date.parse(record.viewedAt),
      activeAt: Date.parse(record.lastActivityAt),
      savedAt: Date.parse(record.savedAt ?? record.createdAt),
      now: Date.now(),
      sleepAfterMs: Number(this.env.SLEEP_AFTER_MS),
      checkpointEveryMs: CHECKPOINT_EVERY_MS,
    });
    if (verdict === "delete") {
      await this.destroy();
      return;
    }
    if (verdict === "sleep") {
      await this.sleep();
      return;
    }
    await this.captureSettings();
    await this.captureProject(record, shell.projects);
    if (verdict === "checkpoint") await this.checkpoint(record);
  }

  /** Called before another sandbox starts, so it begins with what was just edited here. */
  async captureSettingsNow(): Promise<void> {
    if (this.t3Ready && this.container.running) await this.captureSettings();
  }

  /** Project settings edited here (scripts, default model, title) carry to later sandboxes. */
  private async captureProject(
    record: SandboxRecord,
    projects: ReadonlyArray<ShellProject> | undefined,
  ) {
    const project = projects?.find((candidate) => candidate.id === sandboxProjectId(record.repo));
    if (!project || this.projectBaseline === null) return;
    const config = projectConfigOf(project);
    if (sameConfig(config, this.projectBaseline)) return;
    this.projectBaseline = config;
    await directory(controlPlane(this.ctx)).updateProjectConfig(repoName(record), config);
  }

  /**
   * Settings edited in this sandbox, from any client or by an agent, become the
   * template new sandboxes start with. Sandboxes that exist keep their own.
   */
  private async captureSettings() {
    const current = await this.readSettings();
    if (current === null) return;
    const baseline = await this.ctx.storage.get<string>(SETTINGS_BASELINE_KEY);
    if (current === baseline) return;
    await this.ctx.storage.put(SETTINGS_BASELINE_KEY, current);
    if (baseline === undefined) return;
    await directory(controlPlane(this.ctx)).setSettingsTemplate(current);
    // T3 has reloaded the file, so its config now carries the new defaults.
    const token = await this.ctx.storage.get<string>("t3Token");
    if (token) await this.captureServerConfig(token);
  }

  /** settings.json, or null when it is missing or caught mid-write. */
  private async readSettings(): Promise<string | null> {
    const output = await (await this.container.exec(["cat", SETTINGS_PATH])).output();
    if (output.exitCode !== 0) return null;
    const current = new TextDecoder().decode(output.stdout);
    try {
      JSON.parse(current);
      return current;
    } catch {
      return null;
    }
  }

  /**
   * Saves the T3 home to R2, then the disk as a container snapshot. The T3
   * server keeps running, so a checkpoint is crash-consistent, not quiesced.
   */
  private async checkpoint(record: SandboxRecord): Promise<SandboxRecord> {
    const backups = this.backups(record);
    const backup = await this.transfer(() =>
      backups.backup({ dir: T3_HOME, name: record.threadId, exclude: BACKUP_EXCLUDE }),
    );
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

  /**
   * Destroys the container even when it is not running. The local runtime
   * restarts a container that exited with an error, so one deleted between
   * restarts comes back; its first egress request destroys it again.
   */
  private async destroyContainer(reason: string) {
    await this.container.destroy(reason).catch(() => {});
  }

  /** Starts the container if needed and resolves with the T3 bearer token once T3 answers. */
  private ready(): Promise<string> {
    if (this.booting && this.container.running) return this.booting;
    this.booting = this.boot().catch(async (error: unknown) => {
      this.booting = null;
      this.t3Ready = false;
      // The next attempt starts clean rather than finding a half-booted container.
      await this.destroyContainer("boot failed");
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
    const timing = bootTiming();
    // A snapshot holds the checkout's node_modules; a checkout cloned fresh starts from the cache.
    const snapshot = startedHere ? this.usableSnapshot(record) : null;
    const restoresDeps = startedHere && !snapshot && !record.probe;
    const preparedToken = randomId();
    if (startedHere) {
      this.t3Ready = false;
      this.projectBaseline = null;
      if (!record.ranAt) await this.setStep(record, "container");
      await this.intercept(record);
      this.container.start({
        ...(snapshot ? { containerSnapshot: { id: snapshot } } : { image: this.image() }),
        enableInternet: false,
        instance: instanceOf(record),
        env: {
          ...this.sandboxEnv(record),
          T3_SANDBOX_PREPARED: preparedToken,
          ...(restoresDeps ? { T3_SANDBOX_DEPS_RESTORE: "1" } : {}),
          ...(record.probe ? { T3_SANDBOX_PROBE: "1" } : {}),
          ...(record.environmentId ? { T3_SANDBOX_ENVIRONMENT_ID: record.environmentId } : {}),
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
        timing.mark("executable");
        if (record.backup) {
          await this.restoreHome(record, record.backup);
          timing.mark("restored");
        }
        await this.mountShared();
        timing.mark("shared mounted");
        await this.run(["sh", "-c", `printf %s "$0" > ${PREPARED_MARKER}`, preparedToken]);
        if (!record.ranAt) await this.setStep(record, "clone");
      } finally {
        this.phase = null;
      }
      delete record.lastError;
      await this.save(record);
    }

    const descriptor = await this.waitForT3();
    timing.mark("t3 answered");
    let token = await this.ctx.storage.get<string>("t3Token");
    if (startedHere || !token) {
      token = await this.issueToken();
      await this.ctx.storage.put("t3Token", token);
      timing.mark("token");
    }
    // Only now: their disk writes would slow T3's start. The thread waits for neither.
    if (startedHere) {
      this.ctx.waitUntil(
        this.run(["sh", "-c", `printf %s "$0" > ${ANSWERED_MARKER}`, preparedToken]).catch(
          (error: unknown) => console.warn("the background work was not started", String(error)),
        ),
      );
    }
    if (restoresDeps) this.ctx.waitUntil(this.restoreDeps(record));
    // Nobody can have edited settings yet: clients connect only once this boot is done.
    if (startedHere || !(await this.ctx.storage.get<string>(SETTINGS_BASELINE_KEY))) {
      const settings = await this.readSettings();
      if (settings !== null) await this.ctx.storage.put(SETTINGS_BASELINE_KEY, settings);
    }
    if (!record.ranAt) await this.setStep(record, "launch");
    if (!record.probe) {
      this.projectBaseline = await this.ensureProject(record, token);
      timing.mark("project");
      await this.launchPending(record, token);
      timing.mark("thread launched");
    }
    this.step = null;
    record.environmentId = descriptor.environmentId;
    record.ranAt ??= new Date().toISOString();
    this.t3Ready = true;
    await this.save(record);
    if (startedHere) {
      console.log(
        "sandbox boot",
        JSON.stringify({
          threadId: record.threadId,
          controlPlane: timing.steps(),
          container: await this.containerTiming(),
        }),
      );
    }
    if (startedHere && (await this.onSettingsTemplate())) await this.captureServerConfig(token);
    return token;
  }

  /** The entrypoint's steps, in ms each, from the marks it leaves in the container. */
  private async containerTiming(): Promise<Record<string, number> | null> {
    const output = await (await this.container.exec(["cat", TIMING_PATH])).output();
    if (output.exitCode !== 0) return null;
    const marks = new TextDecoder()
      .decode(output.stdout)
      .trim()
      .split("\n")
      .map((line) => line.split(" ") as [string, string]);
    return Object.fromEntries(
      marks.slice(1).map(([label, at], index) => [label, Number(at) - Number(marks[index]![1])]),
    );
  }

  /**
   * Keeps this image's server config (its providers, models and settings) in
   * the directory, so a client can offer them in a sandbox that has not started.
   * Only from a sandbox on the settings template: its settings are what a new
   * thread's composer defaults to.
   */
  private async captureServerConfig(token: string) {
    try {
      await directory(controlPlane(this.ctx)).setServerConfig(await this.readServerConfig(token));
    } catch (error) {
      console.warn("reading the server config failed", String(error));
    }
  }

  /** Whether this sandbox's settings are the template new sandboxes start with. */
  private async onSettingsTemplate(): Promise<boolean> {
    const template = await directory(controlPlane(this.ctx)).settingsTemplate();
    if (template === null) return true;
    const settings = await this.ctx.storage.get<string>(SETTINGS_BASELINE_KEY);
    return settings !== undefined && sameSettings(settings, template);
  }

  /** T3 serves its config only over its RPC socket: one `server.getConfig` request. */
  private async readServerConfig(token: string): Promise<string> {
    const ticket = await this.t3Fetch("/api/auth/websocket-ticket", token, { method: "POST" });
    if (!ticket.ok) throw new Error(`POST /api/auth/websocket-ticket: HTTP ${ticket.status}`);
    const query = new URLSearchParams({
      wsTicket: ((await ticket.json()) as { ticket: string }).ticket,
      orchestrationProtocol: "2",
    });
    const response = await this.container
      .getTcpPort(T3_PORT)
      .fetch(`http://container/ws?${query}`, { headers: { upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error(`GET /ws: HTTP ${response.status}`);
    socket.accept();
    const decoder = new TextDecoder();
    return new Promise<string>((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        try {
          socket.close(1000);
        } catch {}
        settle();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("T3 did not answer server.getConfig."))),
        15_000,
      );
      socket.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : decoder.decode(event.data);
        for (const message of [JSON.parse(data) as RpcExit].flat()) {
          if (message._tag !== "Exit" || message.requestId !== "config") continue;
          const { exit } = message;
          finish(() =>
            exit._tag === "Success"
              ? resolve(JSON.stringify(exit.value))
              : reject(new Error(`server.getConfig failed: ${JSON.stringify(exit)}`)),
          );
        }
      });
      socket.addEventListener("close", () =>
        finish(() => reject(new Error("T3 closed the socket."))),
      );
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "config",
          tag: "server.getConfig",
          payload: {},
          headers: [],
        }),
      );
    });
  }

  private async setStep(record: SandboxRecord, step: SetupStep) {
    this.step = step;
    await this.save(record);
  }

  /**
   * Starts the thread the first message asked for, before any client
   * connects, so no snapshot ever shows the sandbox without it. The launch is
   * idempotent by command id. A failed launch leaves the sandbox up, with the
   * error for the client that sent it.
   */
  private async launchPending(record: SandboxRecord, token: string) {
    if (!record.launch || record.launchedAt) return;
    const response = await this.t3Fetch("/api/orchestration/launch-thread", token, {
      method: "POST",
      body: JSON.stringify(launchRequest(record.launch, sandboxProjectId(record.repo))),
    });
    if (response.ok) {
      await response.body?.cancel();
      record.launchedAt = new Date().toISOString();
      delete record.lastError;
    } else {
      record.lastError = `Starting the thread failed: HTTP ${response.status} ${await response.text()}`;
      console.error("launching the first thread failed", record.lastError);
    }
  }

  /**
   * Restores the project's dependency cache for the container's background
   * install (container/deps.sh), then tells it how that went. Without a cache
   * this image can use, the install starts from nothing, and the directory
   * builds one for the next sandbox.
   */
  private async restoreDeps(record: SandboxRecord) {
    let outcome = "none";
    try {
      const plane = directory(controlPlane(this.ctx));
      const repo = repoName(record);
      const [cache, toolchain] = await Promise.all([
        plane.depsCache(repo),
        this.output(["cat", TOOLCHAIN_PATH]),
      ]);
      if (cache && cache.toolchain === toolchain.trim()) {
        await this.transfer(() =>
          this.depsBackups(repo).restore(cache.backup, { dir: DEPS_CACHE_DIR }),
        );
        outcome = `restored ${cache.commit}`;
      } else {
        this.ctx.waitUntil(
          plane
            .checkDeps(repo, { toolchain: toolchain.trim() })
            .catch((error: unknown) =>
              console.warn("checking the dependency cache failed", String(error)),
            ),
        );
      }
    } catch (error) {
      outcome = "failed";
      console.warn("restoring the dependency cache failed", String(error));
    }
    await this.run(["sh", "-c", `printf '%s\\n' "$0" > ${DEPS_RESTORED_MARKER}`, outcome]).catch(
      (error: unknown) => console.warn("the dependency install was not told", String(error)),
    );
  }

  /**
   * One step of a dependency cache build: starts the builder container (the
   * entrypoint clones the default branch and installs), then, once its install
   * is done, saves the cache and hands it to the directory. Never runs an agent.
   */
  private async buildDepsTick(record: SandboxRecord) {
    const startedAt = record.depsBuild?.startedAt;
    if (!startedAt) {
      await this.intercept(record);
      this.container.start({
        image: this.image(),
        enableInternet: false,
        instance: instanceOf(record),
        env: { ...this.sandboxEnv(record), T3_SANDBOX_DEPS_BUILD: "1" },
        labels: { thread: record.threadId.slice(0, 64) },
      });
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      record.depsBuild = { startedAt: new Date().toISOString() };
      await this.save(record);
      return;
    }
    const elapsed = Date.now() - Date.parse(startedAt);
    const [state] = (await this.output(["cat", DEPS_STATUS_PATH]).catch(() => "")).split(" ");
    if (state === "done") {
      const repo = repoName(record);
      const [lockfile, commit, toolchain] = (
        await this.output([
          "sh",
          "-c",
          `cd /workspace/${record.repo.name} && sha256sum pnpm-lock.yaml | cut -d' ' -f1 && git rev-parse HEAD && cat ${TOOLCHAIN_PATH}`,
        ])
      )
        .trim()
        .split("\n");
      const backup = await this.transfer(() =>
        this.depsBackups(repo).backup({ dir: DEPS_CACHE_DIR, name: repo }),
      );
      const cache: DepsCache = {
        backup,
        lockfile: lockfile!,
        commit: commit!,
        toolchain: toolchain!,
        builtAt: new Date().toISOString(),
      };
      await directory(controlPlane(this.ctx)).setDepsCache(repo, cache);
      console.log(
        "dependency cache built",
        JSON.stringify({ repo, commit, size: backup.size, ms: elapsed }),
      );
      await this.destroy();
      return;
    }
    // The container exits when its clone fails.
    const lost = !this.container.running && elapsed > 60_000;
    if (state === "failed" || state === "none" || lost || elapsed > DEPS_BUILD_TIMEOUT_MS) {
      const log = await this.output(["tail", "-c", "2000", "/var/log/t3-sandbox-deps.log"]).catch(
        () => "",
      );
      const reason =
        state === "none"
          ? "The default branch has no pnpm-lock.yaml."
          : lost
            ? "The builder container exited; it could not clone the repository."
            : state === "failed"
              ? `pnpm install failed:\n${log}`
              : "The build timed out.";
      throw new Error(reason);
    }
  }

  private depsBackups(repo: string) {
    return new DirectoryBackup(this.container, controlPlane(this.ctx).DirectoryBackupGateway, {
      binding: "BACKUPS",
      prefix: depsPrefix(repo),
    });
  }

  private transfer<T>(run: () => Promise<T>): Promise<T> {
    const next = this.transfers.then(run, run);
    this.transfers = next.catch(() => {});
    return next;
  }

  /**
   * Puts the T3 home back while the entrypoint waits. Restoring over a
   * directory the image or snapshot holds fails on an overlay root (EXDEV), so
   * the old copy goes first; T3 has not started, so nothing holds it open.
   */
  private async restoreHome(record: SandboxRecord, backup: DirectoryBackupRecord) {
    await this.run(["rm", "-rf", T3_HOME]);
    await this.transfer(() => this.backups(record).restore(backup, { dir: T3_HOME }));
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
   * The checkout's project, created once with an id derived from the repo and
   * the config the control plane keeps for it, so T3 never bootstraps one with
   * an empty thread and every sandbox for a repo has the same project. Returns
   * its config as T3 has it now.
   */
  private async ensureProject(record: SandboxRecord, token: string): Promise<ProjectConfig> {
    const projectId = sandboxProjectId(record.repo);
    const shell = await this.t3Json<{ projects: ShellProject[] }>(
      "/api/orchestration/shell",
      token,
    );
    const existing = shell.projects.find((project) => project.id === projectId);
    if (existing) return projectConfigOf(existing);
    const kept = (await directory(controlPlane(this.ctx)).project(repoName(record)))?.config;
    const config: ProjectConfig = kept ?? {
      title: record.repo.name,
      defaultModelSelection: null,
      scripts: [],
    };
    const response = await this.t3Fetch("/api/projects/mutate", token, {
      method: "POST",
      body: JSON.stringify({
        type: "project.create",
        commandId: randomId(),
        projectId,
        title: config.title,
        workspaceRoot: `/workspace/${record.repo.name}`,
        ...(config.defaultModelSelection
          ? { defaultModelSelection: config.defaultModelSelection }
          : {}),
        ...(config.scripts.length > 0 ? { scripts: config.scripts } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Creating the project failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    await response.body?.cancel();
    return config;
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

  /** A command's stdout; throws when it fails. */
  private async output(argv: string[]): Promise<string> {
    const output = await (await this.container.exec(argv)).output();
    const decoder = new TextDecoder();
    if (output.exitCode !== 0) {
      throw new Error(`${argv[0]} failed: ${decoder.decode(output.stderr)}`);
    }
    return decoder.decode(output.stdout);
  }

  private async run(argv: string[]) {
    await this.output(argv);
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
    if (!unlisted(record)) await directory(controlPlane(this.ctx)).upsert(this.summary(record));
  }

  private status(record: SandboxRecord): SandboxStatus {
    if (record.unstarted) return "unstarted";
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
      instance: instanceOf(record),
      projectId: sandboxProjectId(record.repo),
      savedAt: record.savedAt ?? null,
      lastActivityAt: record.lastActivityAt,
      lastError: record.lastError ?? null,
      ranAt: record.ranAt ?? null,
      setupStep: record.ranAt || !this.booting ? null : this.step,
      pendingThread:
        record.launch && !record.launchedAt
          ? {
              threadId: record.launch.threadId,
              title: record.launch.title,
              createdAt: record.launch.createdAt,
              modelSelection: record.launch.modelSelection,
              runtimeMode: record.launch.runtimeMode,
              interactionMode: record.launch.interactionMode,
            }
          : null,
    };
  }
}

interface ShellProject {
  readonly id: string;
  readonly title: string;
  readonly defaultModelSelection?: Json;
  readonly scripts?: ReadonlyArray<Json>;
}

const repoName = (record: SandboxRecord) => `${record.repo.owner}/${record.repo.name}`;

/** Sandboxes the control plane runs for itself: no thread, never listed. */
const unlisted = (record: SandboxRecord) => record.probe === true || record.depsBuild !== undefined;

const backupPrefix = (record: SandboxRecord) => `${record.threadId}/`;

/** A v4 UUID: what T3 writes as its environment id. */
const randomUuid = () => {
  const hex = randomId();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
