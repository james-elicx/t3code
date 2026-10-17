import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { BoxIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { waitForProject } from "../state/entities";
import { createSandbox, getSandbox, newSandboxId } from "./directory";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const LAST_REPO_KEY = "t3code:sandbox:last-repo";
const STATUS_POLL_MS = 2000;
const CONNECT_TIMEOUT_MS = 120_000;

type LaunchPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "booting"; readonly sandboxId: string }
  | { readonly kind: "connecting"; readonly projectRef: ScopedProjectRef }
  | { readonly kind: "failed"; readonly message: string };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Starts a sandbox for a repository none of your machines has: creates it,
 * waits for its T3 server to boot and connect, then opens a new thread in its
 * project. The thread's first message is the sandbox's one thread.
 */
export function SandboxLauncher() {
  const handleNewThread = useNewThreadHandler();
  const [repo, setRepo] = useState(() => localStorage.getItem(LAST_REPO_KEY) ?? "");
  const [phase, setPhase] = useState<LaunchPhase>({ kind: "idle" });
  const repoValid = REPO_PATTERN.test(repo.trim());

  const start = async () => {
    const target = repo.trim();
    if (!REPO_PATTERN.test(target)) return;
    localStorage.setItem(LAST_REPO_KEY, target);
    const sandboxId = newSandboxId();
    setPhase({ kind: "booting", sandboxId });
    try {
      await createSandbox({ threadId: sandboxId, repo: target, title: target });
    } catch (error) {
      setPhase({ kind: "failed", message: errorMessage(error) });
    }
  };

  // Connected once the sandbox's project arrives; open a new thread in it.
  const openThread = useEffectEvent(async (ref: ScopedProjectRef) => {
    setPhase({ kind: "connecting", projectRef: ref });
    try {
      await waitForProject(ref, CONNECT_TIMEOUT_MS);
      await handleNewThread(ref, { replace: true });
    } catch {
      setPhase({ kind: "failed", message: "It started, but this app could not connect to it." });
    }
  });

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
          void openThread(
            scopeProjectRef(
              EnvironmentId.make(entry.environmentId),
              ProjectId.make(entry.projectId),
            ),
          );
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

  const busy = phase.kind === "booting" || phase.kind === "connecting";
  return (
    <Empty className="flex-1">
      <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
        <EmptyHeader className="max-w-none">
          <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
            <BoxIcon className="size-5" />
          </div>
          <EmptyTitle>Start from a GitHub repository</EmptyTitle>
          <EmptyDescription>
            A new sandbox clones the repository and holds one thread. Its credentials stay with the
            control plane. For a project on your own machine, start a thread there and turn on the
            sandbox toggle.
          </EmptyDescription>
          <form
            className="mt-6 flex flex-col gap-3 text-left"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
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
                  : "Start sandbox"}
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
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              render={<Link to="/settings/connections" />}
            >
              Or connect your own computer
            </Button>
          </form>
        </EmptyHeader>
      </div>
    </Empty>
  );
}

/** The launcher as a full page: `/sandbox`, and the landing before any environment exists. */
export function SandboxLauncherPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
            {APP_DISPLAY_NAME}
          </span>
        </WorkspacePageHeader>
        <SandboxLauncher />
      </div>
    </SidebarInset>
  );
}
