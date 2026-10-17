import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { randomUUID } from "../lib/utils";
import { type SandboxLaunch, startSandbox, useSandboxDirectoryStore } from "./directory";

type CreateThread = NonNullable<NonNullable<StartThreadTurnInput["bootstrap"]>["createThread"]>;

/** The launch the control plane runs in the sandbox, from a draft's first send. */
export function sandboxLaunchFromTurn(
  input: StartThreadTurnInput,
  thread: CreateThread,
): SandboxLaunch {
  return {
    commandId: input.commandId ?? randomUUID(),
    threadId: input.threadId,
    title: input.titleSeed ?? thread.title,
    modelSelection: input.modelSelection ?? thread.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: input.createdAt ?? thread.createdAt,
    initialMessage: {
      messageId: input.message.messageId,
      text: input.message.text,
      ...(input.message.context === undefined ? {} : { context: input.message.context }),
    },
  };
}

function unstartedSandboxFor(environmentId: EnvironmentId) {
  return (
    useSandboxDirectoryStore
      .getState()
      .entries.find(
        (entry) => entry.environmentId === environmentId && entry.status === "unstarted",
      ) ?? null
  );
}

/**
 * Wraps the composer's start-turn command: a draft's first message into a
 * project's unstarted sandbox goes to the control plane, which boots the
 * sandbox and launches the thread there. Everything else, and every send
 * once the sandbox runs, is the normal command. The client then shows the
 * thread as preparing until the sandbox answers (see registrations.ts).
 */
export function useSandboxStartTurn<
  W extends { environmentId: EnvironmentId; input: StartThreadTurnInput },
  A,
  E,
>(
  dispatch: (value: W) => Promise<AtomCommandResult<A, E>>,
): (value: W) => Promise<AtomCommandResult<A | { threadId: string }, E | Error>> {
  return useCallback(
    async (value: W) => {
      const sandbox = unstartedSandboxFor(value.environmentId);
      const thread = value.input.bootstrap?.createThread;
      if (sandbox === null || thread === undefined) return dispatch(value);
      if (value.input.message.attachments.length > 0) {
        return AsyncResult.failure(
          Cause.fail(
            new Error("Send a new sandbox's first message as text, then attach files there."),
          ),
        );
      }
      try {
        await startSandbox(sandbox.threadId, {
          launch: sandboxLaunchFromTurn(value.input, thread),
        });
        return AsyncResult.success({ threadId: value.input.threadId });
      } catch (error) {
        return AsyncResult.failure(
          Cause.fail(error instanceof Error ? error : new Error(String(error))),
        );
      }
    },
    [dispatch],
  );
}
