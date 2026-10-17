import { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";
import { type SandboxStatus, useSandboxDirectoryStore, wakeSandbox } from "./directory";

const SYNCED_KEY_PREFIX = "t3code:sandbox:synced:";
const woken = new Set<string>();

/**
 * Reconnects a sandbox the moment it runs, since its connection backs off
 * while it boots or sleeps. A browser lists a sandbox's thread from its cache
 * while the sandbox sleeps, so one that has never seen a sandbox wakes it once
 * to sync its thread. Opening the thread wakes it again for anything newer.
 */
export function SandboxSync() {
  const entries = useSandboxDirectoryStore((state) => state.entries);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const statuses = useRef(new Map<string, SandboxStatus>());

  useEffect(() => {
    for (const entry of entries) {
      const previous = statuses.current.get(entry.threadId);
      statuses.current.set(entry.threadId, entry.status);
      const running = entry.status === "running" && entry.environmentId !== null;
      if (running && previous !== undefined && previous !== "running") {
        void retryEnvironment(EnvironmentId.make(entry.environmentId ?? ""));
      }

      const key = `${SYNCED_KEY_PREFIX}${entry.threadId}`;
      if (localStorage.getItem(key) !== null) continue;
      if (running) {
        localStorage.setItem(key, "1");
      } else if (entry.status === "asleep" && !woken.has(entry.threadId)) {
        woken.add(entry.threadId);
        void wakeSandbox(entry.threadId).catch(() => woken.delete(entry.threadId));
      }
    }
  }, [entries, retryEnvironment]);

  return null;
}
