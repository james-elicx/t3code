/**
 * Projects and the first thread of a sandbox, as the control plane keeps
 * them. Shapes that cross into T3 mirror its contracts loosely: the control
 * plane passes them through rather than interpreting them.
 */

/**
 * Values passed through to T3 untouched. Durable Object RPC types reject both
 * `unknown` and recursive types, hence a JSON type of bounded depth.
 */
type JsonLevel<Inner> = Inner | ReadonlyArray<Inner> | { readonly [key: string]: Inner };
type JsonScalar = string | number | boolean | null;
export type Json = JsonLevel<JsonLevel<JsonLevel<JsonLevel<JsonLevel<JsonScalar>>>>>;

/** What carries from one sandbox's project to the next: what users edit in Settings. */
export interface ProjectConfig {
  readonly title: string;
  readonly defaultModelSelection: Json;
  readonly scripts: ReadonlyArray<Json>;
}

export interface SandboxProject {
  /** `owner/name` on GitHub. */
  readonly repo: string;
  readonly createdAt: string;
  readonly config: ProjectConfig;
}

/**
 * A thread's first message, sent with the request that starts its sandbox.
 * The control plane launches it in the sandbox's T3 server before anyone can
 * connect, so the thread is there from the first snapshot.
 */
export interface SandboxLaunch {
  readonly commandId: string;
  readonly threadId: string;
  readonly title: string;
  readonly modelSelection: Json;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly createdAt: string;
  readonly initialMessage: {
    readonly messageId: string;
    readonly text: string;
    readonly context?: Json;
  };
}

export function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...extra] = repo.trim().split("/");
  if (!owner || !name || extra.length > 0 || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) {
    throw new Error("repo must be owner/name.");
  }
  return { owner, name: name.replace(/\.git$/i, "") };
}

/** A launch from a client, or an error message for one the control plane cannot carry out. */
export function parseLaunch(value: unknown): SandboxLaunch | string {
  if (typeof value !== "object" || value === null) return "launch must be an object.";
  const launch = value as Record<string, unknown>;
  for (const key of ["commandId", "threadId", "title", "runtimeMode", "interactionMode"]) {
    if (typeof launch[key] !== "string" || (launch[key] as string).trim() === "") {
      return `launch.${key} is required.`;
    }
  }
  if (typeof launch.modelSelection !== "object" || launch.modelSelection === null) {
    return "launch.modelSelection is required.";
  }
  const message = launch.initialMessage as Record<string, unknown> | undefined;
  if (typeof message?.messageId !== "string" || typeof message.text !== "string") {
    return "launch.initialMessage needs a messageId and text.";
  }
  return {
    commandId: launch.commandId as string,
    threadId: launch.threadId as string,
    title: launch.title as string,
    modelSelection: launch.modelSelection as Json,
    runtimeMode: launch.runtimeMode as string,
    interactionMode: launch.interactionMode as string,
    createdAt: typeof launch.createdAt === "string" ? launch.createdAt : new Date().toISOString(),
    initialMessage: {
      messageId: message.messageId,
      text: message.text,
      ...(message.context === undefined ? {} : { context: message.context as Json }),
    },
  };
}

/** The launch as T3's `POST /api/orchestration/launch-thread` takes it, into the checkout. */
export function launchRequest(launch: SandboxLaunch, projectId: string) {
  return {
    commandId: launch.commandId,
    creationSource: "web",
    threadId: launch.threadId,
    projectId,
    title: launch.title,
    generateTitle: true,
    modelSelection: launch.modelSelection,
    runtimeMode: launch.runtimeMode,
    interactionMode: launch.interactionMode,
    // The sandbox's checkout is its workspace; a worktree would live outside what it saves.
    workspaceStrategy: { type: "root" },
    initialMessage: { ...launch.initialMessage, attachments: [] },
  };
}

/** A project's editable config as T3's shell reports it. */
export function projectConfigOf(project: {
  readonly title: string;
  readonly defaultModelSelection?: Json;
  readonly scripts?: ReadonlyArray<Json>;
}): ProjectConfig {
  return {
    title: project.title,
    defaultModelSelection: project.defaultModelSelection ?? null,
    scripts: project.scripts ?? [],
  };
}

export const sameConfig = (a: ProjectConfig, b: ProjectConfig) =>
  JSON.stringify(a) === JSON.stringify(b);
