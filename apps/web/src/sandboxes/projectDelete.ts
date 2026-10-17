import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { deleteSandbox, readSandboxForEnvironment, removeSandboxProject } from "./directory";

/**
 * Wraps the delete-project command. Each sandbox holds one copy of its
 * repository's project, so removing that copy deletes the sandbox and its
 * thread; removing the copy in the project's unstarted sandbox removes the
 * repository from the control plane. Anything else is the normal command.
 */
export function useSandboxProjectDelete<W extends { environmentId: EnvironmentId }, A, E>(
  dispatch: (value: W) => Promise<AtomCommandResult<A, E>>,
): (value: W) => Promise<AtomCommandResult<A | null, E | Error>> {
  return useCallback(
    async (value: W) => {
      const sandbox = readSandboxForEnvironment(value.environmentId);
      if (sandbox === null) return dispatch(value);
      try {
        if (sandbox.status === "unstarted") await removeSandboxProject(sandbox.repo);
        else await deleteSandbox(sandbox.threadId);
        return AsyncResult.success(null);
      } catch (error) {
        return AsyncResult.failure(
          Cause.fail(error instanceof Error ? error : new Error(String(error))),
        );
      }
    },
    [dispatch],
  );
}
