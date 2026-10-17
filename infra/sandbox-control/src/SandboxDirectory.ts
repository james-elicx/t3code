import { DurableObject } from "cloudflare:workers";

import type { ControlPlaneExports, Env } from "./env.ts";
import type { SandboxSummary } from "./ThreadSandbox.ts";

/**
 * The list of sandboxes, which Durable Objects cannot enumerate themselves.
 * Each ThreadSandbox pushes its summary here, so clients can render idle
 * sandboxes without waking them. One instance today; one per user once
 * Cloudflare Access identities are wired in.
 */
export class SandboxDirectory extends DurableObject<Env> {
  async upsert(summary: SandboxSummary): Promise<void> {
    await this.ctx.storage.put(`sandbox:${summary.threadId}`, summary);
  }

  async remove(threadId: string): Promise<void> {
    await this.ctx.storage.delete(`sandbox:${threadId}`);
  }

  /** The settings.json new sandboxes start with: the last one edited in any sandbox. */
  async settingsTemplate(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("settingsTemplate")) ?? null;
  }

  async setSettingsTemplate(json: string): Promise<void> {
    await this.ctx.storage.put("settingsTemplate", json);
  }

  async list(): Promise<SandboxSummary[]> {
    const entries = await this.ctx.storage.list<SandboxSummary>({ prefix: "sandbox:" });
    return [...entries.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }
}

export const directory = (exports: ControlPlaneExports) =>
  exports.SandboxDirectory.getByName("global");
