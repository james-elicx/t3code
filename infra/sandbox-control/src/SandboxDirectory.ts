import { DurableObject } from "cloudflare:workers";

import {
  depsObjectKey,
  depsPrefix,
  depsSummary,
  needsBuild,
  sha256Hex,
  type DepsCache,
  type DepsState,
  type DepsSummary,
} from "./depsCache.ts";
import { controlPlane, type ControlPlaneExports, type Env } from "./env.ts";
import { defaultBranchHead, fileAt } from "./github.ts";
import { parseRepo, type ProjectConfig, type SandboxProject } from "./projects.ts";
import type { SandboxSummary } from "./ThreadSandbox.ts";

/**
 * The control plane's own state: every sandbox's summary (Durable Objects
 * cannot enumerate themselves), the projects, and the settings new sandboxes
 * start with. One instance today; one per user once Cloudflare Access
 * identities are wired in.
 *
 * Each project keeps one unstarted sandbox: a record with an environment id
 * and no container. Clients list it like any sandbox, so the project is there
 * before anything runs, and a new thread's first message starts it.
 */
/** How long a probe has before another may start. */
const PROBE_RETRY_MS = 5 * 60 * 1000;

export class SandboxDirectory extends DurableObject<Env> {
  /** Slot allocation runs one at a time, so a project never gets two. */
  private slots: Promise<unknown> = Promise.resolve();
  /** Each project's dependency check in flight, so two never start two builds. */
  private depsChecks = new Map<string, Promise<void>>();

  async upsert(summary: SandboxSummary): Promise<void> {
    await this.ctx.storage.put(`sandbox:${summary.threadId}`, summary);
  }

  async remove(threadId: string): Promise<void> {
    await this.ctx.storage.delete(`sandbox:${threadId}`);
  }

  async list(): Promise<SandboxSummary[]> {
    const entries = await this.ctx.storage.list<SandboxSummary>({ prefix: "sandbox:" });
    return [...entries.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  /** The settings.json new sandboxes start with: the last one edited in any sandbox. */
  async settingsTemplate(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("settingsTemplate")) ?? null;
  }

  async setSettingsTemplate(json: string): Promise<void> {
    await this.ctx.storage.put("settingsTemplate", json);
  }

  /**
   * The server config of the last sandbox that booted. Every sandbox runs the
   * same image, so clients offer its providers and models in one that has not
   * started.
   */
  async serverConfig(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("serverConfig")) ?? null;
  }

  async setServerConfig(json: string): Promise<void> {
    await this.ctx.storage.put({ serverConfig: json, serverConfigAt: Date.now() });
  }

  /** When the server config last changed, so clients know to read it again. */
  async serverConfigAt(): Promise<number | null> {
    const at = await this.ctx.storage.get<number>("serverConfigAt");
    if (at !== undefined) return at;
    // Kept before configs were versioned.
    return (await this.serverConfig()) === null ? null : 0;
  }

  /**
   * Before any sandbox has booted there is no server config, so a probe boots
   * the image once without a repository to read one. Retried after a while if
   * it fails; every boot after it refreshes the config, as when the image changes.
   */
  async ensureServerConfig(): Promise<void> {
    if (await this.serverConfig()) return;
    const startedAt = (await this.ctx.storage.get<number>("probeStartedAt")) ?? 0;
    if (Date.now() - startedAt < PROBE_RETRY_MS) return;
    await this.ctx.storage.put("probeStartedAt", Date.now());
    const id = `probe-${Date.now().toString(36)}`;
    await this.exports().ThreadSandbox.getByName(id).probe(id);
  }

  async forgetServerConfig(): Promise<void> {
    await this.ctx.storage.delete(["serverConfig", "serverConfigAt", "probeStartedAt"]);
  }

  /**
   * Sandboxes running now save the settings edited in them, so a sandbox
   * starting next begins with them rather than waiting for their next tick.
   */
  async captureRunningSettings(): Promise<void> {
    const exports = this.exports();
    const running = (await this.list()).filter((summary) => summary.status === "running");
    await Promise.all(
      running.map((summary) =>
        exports.ThreadSandbox.getByName(summary.threadId)
          .captureSettingsNow()
          .catch((error: unknown) => console.warn("capturing settings failed", String(error))),
      ),
    );
  }

  async projects(): Promise<SandboxProject[]> {
    const entries = await this.ctx.storage.list<SandboxProject>({ prefix: "project:" });
    return [...entries.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  }

  async project(repo: string): Promise<SandboxProject | null> {
    return (await this.ctx.storage.get<SandboxProject>(projectKey(repo))) ?? null;
  }

  /** Adds a project for a GitHub repository, with its unstarted sandbox. Idempotent. */
  async addProject(repo: string): Promise<void> {
    const parsed = parseRepo(repo);
    const key = projectKey(repo);
    if (!(await this.ctx.storage.get(key))) {
      const project: SandboxProject = {
        repo: `${parsed.owner}/${parsed.name}`,
        createdAt: new Date().toISOString(),
        config: { title: parsed.name, defaultModelSelection: null, scripts: [] },
      };
      await this.ctx.storage.put(key, project);
    }
    await this.ensureSlot(repo);
    // Its first dependency cache builds now, before there is a thread to want it.
    await this.scheduleDepsChecks();
    this.ctx.waitUntil(this.checkDeps(repo).catch(warnDepsCheck));
  }

  /** Project settings edited in a sandbox: what every later sandbox's project starts with. */
  async updateProjectConfig(repo: string, config: ProjectConfig): Promise<void> {
    const project = await this.project(repo);
    if (project) await this.ctx.storage.put(projectKey(repo), { ...project, config });
  }

  /** Removes the project, its unstarted sandbox and its dependency caches; sandboxes with threads stay. */
  async removeProject(repo: string): Promise<void> {
    await this.ctx.storage.delete([projectKey(repo), depsKey(repo)]);
    const cached = await this.env.BACKUPS.list({ prefix: depsPrefix(repo) });
    if (cached.objects.length > 0) {
      await this.env.BACKUPS.delete(cached.objects.map((object) => object.key));
    }
    const exports = this.exports();
    for (const summary of await this.unstartedSlots(repo)) {
      await exports.ThreadSandbox.getByName(summary.threadId).destroy();
    }
  }

  /** Gives every project an unstarted sandbox again, as when one was deleted by hand. */
  async ensureSlots(): Promise<void> {
    for (const project of await this.projects()) await this.ensureSlot(project.repo);
    await this.scheduleDepsChecks();
  }

  /** The cache a new sandbox for the project restores, if there is one. */
  async depsCache(repo: string): Promise<DepsCache | null> {
    return (await this.depsState(repo)).cache ?? null;
  }

  async dependencies(repo: string): Promise<DepsSummary> {
    return depsSummary(await this.depsState(repo));
  }

  /**
   * Builds the project a new dependency cache when its default branch's
   * lockfile has none, or when a sandbox reports an image (`toolchain`) the
   * cache does not fit. Runs every DEPS_CHECK_MS, when a project is added, and
   * when a sandbox finds no cache it can use, so the next sandbox has one.
   */
  checkDeps(repo: string, report: { toolchain?: string } = {}): Promise<void> {
    const running = this.depsChecks.get(repo);
    if (running) return running;
    const check = this.runDepsCheck(repo, report).finally(() => this.depsChecks.delete(repo));
    this.depsChecks.set(repo, check);
    return check;
  }

  /** From the builder sandbox: the new cache replaces the project's current one. */
  async setDepsCache(repo: string, cache: DepsCache): Promise<void> {
    const state = await this.depsState(repo);
    if (!(await this.project(repo))) {
      // Removed while it built.
      await this.env.BACKUPS.delete(depsObjectKey(repo, cache.backup));
      return;
    }
    // The one before last can go; the last stays for sandboxes still restoring it.
    if (state.previous) await this.env.BACKUPS.delete(depsObjectKey(repo, state.previous));
    const { building: _building, failed: _failed, ...rest } = state;
    await this.ctx.storage.put<DepsState>(depsKey(repo), {
      ...rest,
      cache,
      ...(state.cache ? { previous: state.cache.backup } : {}),
    });
  }

  async depsBuildFailed(repo: string, error: string): Promise<void> {
    if (!(await this.project(repo))) return;
    const state = await this.depsState(repo);
    const { building: _building, ...rest } = state;
    console.error("building a dependency cache failed", repo, error);
    await this.ctx.storage.put<DepsState>(depsKey(repo), {
      ...rest,
      failed: { lockfile: state.checked?.lockfile ?? null, at: new Date().toISOString(), error },
    });
  }

  override async alarm(): Promise<void> {
    for (const project of await this.projects()) {
      await this.checkDeps(project.repo).catch(warnDepsCheck);
    }
    await this.scheduleDepsChecks();
  }

  private async runDepsCheck(repo: string, report: { toolchain?: string }) {
    const commit = await defaultBranchHead(this.env, repo);
    if (commit === null) return;
    const checked = (await this.depsState(repo)).checked;
    let lockfile = checked?.commit === commit ? checked.lockfile : undefined;
    if (lockfile === undefined) {
      const file = await fileAt(this.env, repo, commit, "pnpm-lock.yaml");
      lockfile = file === null ? null : await sha256Hex(file);
    }
    // Read again: a build may have finished while GitHub answered.
    if (!(await this.project(repo))) return;
    let state: DepsState = { ...(await this.depsState(repo)), checked: { commit, lockfile } };
    const build = needsBuild(state, { lockfile, now: Date.now(), ...report });
    const id = `deps-${newSandboxId().slice(2)}`;
    if (build) state = { ...state, building: { id, startedAt: new Date().toISOString() } };
    await this.ctx.storage.put(depsKey(repo), state);
    if (build) await this.exports().ThreadSandbox.getByName(id).buildDeps(id, repo);
  }

  private async depsState(repo: string): Promise<DepsState> {
    return (await this.ctx.storage.get<DepsState>(depsKey(repo))) ?? {};
  }

  private async scheduleDepsChecks() {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    if ((await this.projects()).length === 0) return;
    await this.ctx.storage.setAlarm(Date.now() + Number(this.env.DEPS_CHECK_MS));
  }

  /** A project's unstarted sandbox took a thread; the next thread gets a fresh one. */
  async slotStarted(repo: string): Promise<void> {
    if (await this.project(repo)) await this.ensureSlot(repo);
  }

  private ensureSlot(repo: string): Promise<void> {
    const run = this.slots.then(async () => {
      if ((await this.unstartedSlots(repo)).length > 0) return;
      const id = newSandboxId();
      await this.exports().ThreadSandbox.getByName(id).allocate({ threadId: id, repo });
    });
    this.slots = run.catch(() => undefined);
    return run;
  }

  private async unstartedSlots(repo: string) {
    const key = projectKey(repo);
    return (await this.list()).filter(
      (summary) => summary.status === "unstarted" && projectKey(summary.repo) === key,
    );
  }

  private exports(): ControlPlaneExports {
    return controlPlane(this.ctx);
  }
}

const projectKey = (repo: string) => `project:${repo.toLowerCase()}`;
const depsKey = (repo: string) => `deps:${repo.toLowerCase()}`;

const warnDepsCheck = (error: unknown) =>
  console.warn("checking the dependency cache failed", String(error));

/** Sandbox ids are DNS labels: they name the sandbox's path, `/s/<id>`. */
export function newSandboxId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `t-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const directory = (exports: ControlPlaneExports) =>
  exports.SandboxDirectory.getByName("global");
