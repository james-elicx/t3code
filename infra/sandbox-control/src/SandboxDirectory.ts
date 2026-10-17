import { DurableObject } from "cloudflare:workers";

import { controlPlane, type ControlPlaneExports, type Env } from "./env.ts";
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
export class SandboxDirectory extends DurableObject<Env> {
  /** Slot allocation runs one at a time, so a project never gets two. */
  private slots: Promise<unknown> = Promise.resolve();

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
   * The last server config a client read from a running sandbox. Every
   * sandbox runs the same image, so clients offer its providers and models
   * for one that has not started.
   */
  async serverConfig(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("serverConfig")) ?? null;
  }

  async setServerConfig(json: string): Promise<void> {
    await this.ctx.storage.put("serverConfig", json);
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
  }

  /** Project settings edited in a sandbox: what every later sandbox's project starts with. */
  async updateProjectConfig(repo: string, config: ProjectConfig): Promise<void> {
    const project = await this.project(repo);
    if (project) await this.ctx.storage.put(projectKey(repo), { ...project, config });
  }

  /** Removes the project and its unstarted sandbox; sandboxes with threads stay. */
  async removeProject(repo: string): Promise<void> {
    await this.ctx.storage.delete(projectKey(repo));
    const exports = this.exports();
    for (const summary of await this.unstartedSlots(repo)) {
      await exports.ThreadSandbox.getByName(summary.threadId).destroy();
    }
  }

  /** Gives every project an unstarted sandbox again, as when one was deleted by hand. */
  async ensureSlots(): Promise<void> {
    for (const project of await this.projects()) await this.ensureSlot(project.repo);
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

/** Sandbox ids are DNS labels: they name the sandbox's path, `/s/<id>`. */
export function newSandboxId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `t-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const directory = (exports: ControlPlaneExports) =>
  exports.SandboxDirectory.getByName("global");
