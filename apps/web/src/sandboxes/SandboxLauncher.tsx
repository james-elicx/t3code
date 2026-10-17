import { Link } from "@tanstack/react-router";
import { BoxIcon } from "lucide-react";
import { useState } from "react";

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
import { addSandboxProjectRef } from "./addProject";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

type AddPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "adding" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Adds a GitHub repository none of your machines has as a sandbox project,
 * then opens a new thread in it. The project persists in the control plane;
 * each thread's first message starts its own sandbox.
 */
export function SandboxLauncher() {
  const handleNewThread = useNewThreadHandler();
  const [repo, setRepo] = useState("");
  const [phase, setPhase] = useState<AddPhase>({ kind: "idle" });
  const repoValid = REPO_PATTERN.test(repo.trim());

  const add = async () => {
    const target = repo.trim();
    if (!REPO_PATTERN.test(target)) return;
    setPhase({ kind: "adding" });
    try {
      await handleNewThread(await addSandboxProjectRef(target), { replace: true });
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const busy = phase.kind === "adding";
  return (
    <Empty className="flex-1">
      <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
        <EmptyHeader className="max-w-none">
          <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
            <BoxIcon className="size-5" />
          </div>
          <EmptyTitle>Add a GitHub repository</EmptyTitle>
          <EmptyDescription>
            Each thread in it runs in its own sandbox, which clones the repository when you send its
            first message. Credentials stay with the control plane.
          </EmptyDescription>
          <form
            className="mt-6 flex flex-col gap-3 text-left"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
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
              Add repository
            </Button>
            {phase.kind === "failed" ? (
              <p role="alert" className="text-sm text-destructive">
                Could not add it: {phase.message}
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

/** The launcher as a full page: `/sandbox`, and the landing before any project exists. */
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
