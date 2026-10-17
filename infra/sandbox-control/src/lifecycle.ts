/**
 * When an awake sandbox goes to sleep or saves a checkpoint. The ThreadSandbox
 * alarm asks this every tick with its T3 server's shell, so the rule stays a
 * pure function of what the server reports and when someone last looked.
 */

/** The fields of a thread in `GET /api/orchestration/shell` this rule reads. */
export interface ShellThread {
  readonly id: string;
  readonly settledAt: string | null;
  readonly activeRunId: string | null;
  readonly archivedAt: string | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<unknown>;
}

export interface LifecycleInput {
  readonly threads: ReadonlyArray<ShellThread>;
  /** The thread the sandbox was started for, once T3 has it; null before. */
  readonly threadId: string | null;
  /** Last `/wake` call: a client has the sandbox's thread open. */
  readonly viewedAt: number;
  /** Last view or egress request. */
  readonly activeAt: number;
  /** Last checkpoint or sleep save; 0 when never saved. */
  readonly savedAt: number;
  readonly now: number;
  readonly sleepAfterMs: number;
  readonly checkpointEveryMs: number;
}

export type LifecycleVerdict = "delete" | "sleep" | "checkpoint" | "stay";

/**
 * A sandbox holds one thread, so it is deleted once that thread is. It sleeps
 * once no thread in it has work left (settled, no live run,
 * no background tasks) and nobody has viewed it for `sleepAfterMs`. An awake
 * sandbox checkpoints every `checkpointEveryMs` while something happened since
 * its last save, so a host restart loses at most that much.
 */
export function lifecycleVerdict(input: LifecycleInput): LifecycleVerdict {
  // Deleted in T3 itself, by an agent or a client that went around the control plane.
  if (input.threadId !== null && !input.threads.some((thread) => thread.id === input.threadId)) {
    return "delete";
  }
  const working = input.threads.some(
    (thread) =>
      thread.archivedAt === null &&
      (thread.settledAt === null ||
        thread.activeRunId !== null ||
        (thread.pendingBackgroundTasks?.length ?? 0) > 0),
  );
  if (!working && input.now - input.viewedAt >= input.sleepAfterMs) return "sleep";
  if (input.now - input.savedAt >= input.checkpointEveryMs && input.activeAt > input.savedAt) {
    return "checkpoint";
  }
  return "stay";
}
