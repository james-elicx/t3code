import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BoxIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { createSandbox, getSandbox, newSandboxId } from "./directory";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const LAST_REPO_KEY = "t3code:sandbox:last-repo";
const STATUS_POLL_MS = 2000;

type LaunchPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "booting"; readonly sandboxId: string }
  | { readonly kind: "connecting"; readonly environmentId: EnvironmentId }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Starts a thread in its own sandbox: creates the sandbox for a repo, waits
 * for its T3 server to boot and connect, then opens the one thread the
 * sandbox holds. With a `launchId` it starts that sandbox as soon as it
 * mounts, for "New thread" on a sandbox project.
 */
export function SandboxLauncher(props: { initialRepo?: string; launchId?: string }) {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const [repo, setRepo] = useState(
    () => props.initialRepo ?? localStorage.getItem(LAST_REPO_KEY) ?? "",
  );
  const [phase, setPhase] = useState<LaunchPhase>({ kind: "idle" });
  const repoValid = REPO_PATTERN.test(repo.trim());

  const start = async (sandboxId: string) => {
    const target = repo.trim();
    if (!REPO_PATTERN.test(target)) return;
    localStorage.setItem(LAST_REPO_KEY, target);
    setPhase({ kind: "booting", sandboxId });
    try {
      await createSandbox({ threadId: sandboxId, repo: target, title: target });
    } catch (error) {
      setPhase({ kind: "failed", message: String(error instanceof Error ? error.message : error) });
    }
  };

  const startOnMount = useEffectEvent((sandboxId: string) => void start(sandboxId));
  const autostarted = useRef(false);
  useEffect(() => {
    if (props.launchId === undefined || autostarted.current) return;
    autostarted.current = true;
    startOnMount(props.launchId);
  }, [props.launchId]);

  // The sandbox reports its environment once its T3 server has answered.
  const sandboxId = phase.kind === "booting" ? phase.sandboxId : null;
  useEffect(() => {
    if (sandboxId === null) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const entry = await getSandbox(sandboxId);
        if (cancelled) return;
        if (entry.lastError) setPhase({ kind: "failed", message: entry.lastError });
        else if (entry.environmentId) {
          setPhase({ kind: "connecting", environmentId: EnvironmentId.make(entry.environmentId) });
        }
      } catch {
        // The sandbox may not be listed yet; the next poll asks again.
      }
    };
    void poll();
    const interval = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sandboxId]);

  // Connected once the sandbox's thread arrives with its environment's snapshot.
  const environmentId = phase.kind === "connecting" ? phase.environmentId : null;
  const thread =
    environmentId === null
      ? null
      : (threads.find((candidate) => candidate.environmentId === environmentId) ?? null);
  useEffect(() => {
    if (thread === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      replace: true,
    });
  }, [navigate, thread]);

  const busy = phase.kind === "booting" || phase.kind === "connecting";
  return (
    <Empty className="flex-1">
      <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
        <EmptyHeader className="max-w-none">
          <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
            <BoxIcon className="size-5" />
          </div>
          <EmptyTitle>New sandbox thread</EmptyTitle>
          <EmptyDescription>
            Each thread runs in its own sandbox with a fresh checkout of the repository. Its
            credentials stay with the control plane.
          </EmptyDescription>
          <form
            className="mt-6 flex flex-col gap-3 text-left"
            onSubmit={(event) => {
              event.preventDefault();
              void start(newSandboxId());
            }}
          >
            <Label htmlFor="sandbox-repo">GitHub repository</Label>
            <Input
              id="sandbox-repo"
              aria-label="GitHub repository"
              placeholder="owner/name"
              value={repo}
              disabled={busy}
              onChange={(event) => setRepo(event.target.value)}
            />
            <Button type="submit" disabled={busy || !repoValid}>
              {busy ? <Spinner size="sm" /> : null}
              {phase.kind === "booting"
                ? "Starting sandbox…"
                : phase.kind === "connecting"
                  ? "Connecting…"
                  : "Start sandbox thread"}
            </Button>
            {phase.kind === "booting" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Cloning {repo.trim()} and starting T3. This takes about half a minute.
              </p>
            ) : null}
            {phase.kind === "failed" ? (
              <p role="alert" className="text-sm text-destructive">
                The sandbox did not start: {phase.message}
              </p>
            ) : null}
          </form>
        </EmptyHeader>
      </div>
    </Empty>
  );
}

/** The launcher as a full page: the index landing and `/sandbox` in sandbox mode. */
export function SandboxLauncherPage(props: { initialRepo?: string; launchId?: string }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
            {APP_DISPLAY_NAME}
          </span>
        </WorkspacePageHeader>
        <SandboxLauncher key={props.launchId ?? "form"} {...props} />
      </div>
    </SidebarInset>
  );
}
