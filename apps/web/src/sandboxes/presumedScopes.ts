import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

const NO_PRESUMED_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();

/**
 * Environments a draft may start a thread in before they have connected: a
 * project's unstarted sandbox, whose first thread the control plane launches
 * (see launch.ts). Only starting threads is presumed; state/session.ts reads it.
 */
export const presumedOperateEnvironmentsAtom = Atom.make(NO_PRESUMED_ENVIRONMENTS).pipe(
  Atom.keepAlive,
);
