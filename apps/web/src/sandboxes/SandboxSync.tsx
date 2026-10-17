import { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";
import { useSandboxDirectoryStore, wakeSandbox } from "./directory";

const SYNCED_KEY_PREFIX = "t3code:sandbox:synced:";
const woken = new Set<string>();

/**
 * A browser lists a sandbox's thread from its cache while the sandbox sleeps,
 * so one that has never seen a sandbox wakes it once to sync its thread. Opening
 * the thread wakes it again for anything newer.
 */
export function SandboxSync() {
  const entries = useSandboxDirectoryStore((state) => state.entries);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  useEffect(() => {
    for (const entry of entries) {
      const key = `${SYNCED_KEY_PREFIX}${entry.threadId}`;
      if (localStorage.getItem(key) !== null) continue;
      if (entry.status === "running" && entry.environmentId !== null) {
        localStorage.setItem(key, "1");
        // Its connection may be backing off from when it was asleep.
        if (woken.delete(entry.threadId)) {
          void retryEnvironment(EnvironmentId.make(entry.environmentId));
        }
      } else if (entry.status === "asleep" && !woken.has(entry.threadId)) {
        woken.add(entry.threadId);
        void wakeSandbox(entry.threadId).catch(() => woken.delete(entry.threadId));
      }
    }
  }, [entries, retryEnvironment]);

  return null;
}
