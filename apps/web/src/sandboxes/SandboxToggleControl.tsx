import type { ScopedProjectRef } from "@t3tools/contracts";
import { BoxIcon, LaptopIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useComposerMenuProps } from "../components/chat/composerEventScope";
import { ComposerSelectControl } from "../components/chat/ComposerControl";
import { ComposerContextLabel } from "../components/ComposerContextLabel";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { DraftId } from "../composerDraftStore";
import { addSandboxProjectRef } from "./addProject";
import { moveDraft } from "./toggle";
import { useSandboxToggle } from "./useSandboxToggle";

const SANDBOX = "sandbox";
const MACHINE = "machine";

/** Adds the repository as a sandbox project, then moves the draft into its unstarted sandbox. */
async function moveDraftToNewSandboxProject(draftId: DraftId, repo: string) {
  try {
    moveDraft(draftId, await addSandboxProjectRef(repo));
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Could not add ${repo} for sandboxes`,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The composer's sandbox toggle for a draft: it moves the draft between the
 * project's unstarted sandbox, which its first message starts, and the same
 * repository on one of your machines. Renders nothing outside sandbox mode.
 */
export const SandboxToggleControl = memo(function SandboxToggleControl(props: {
  draftId: DraftId;
  projectRef: ScopedProjectRef;
}) {
  const toggle = useSandboxToggle(props.draftId, props.projectRef);
  const composerFloatingLayerProps = useComposerMenuProps();
  const items = useMemo(
    () => [
      { value: SANDBOX, label: "New sandbox" },
      { value: MACHINE, label: "Your machine" },
    ],
    [],
  );

  if (toggle.kind === "hidden") return null;
  if (toggle.kind === "unavailable") {
    const row = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        <LaptopIcon className="size-3" />
        <ComposerContextLabel>No sandbox</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={row} />
        <TooltipPopup>{toggle.reason}</TooltipPopup>
      </Tooltip>
    );
  }

  const onValueChange = (value: string | null) => {
    if (value === SANDBOX && !toggle.on) {
      if (toggle.sandboxProjectRef) moveDraft(props.draftId, toggle.sandboxProjectRef);
      else void moveDraftToNewSandboxProject(props.draftId, toggle.repo);
    } else if (value === MACHINE && toggle.on && toggle.machineProjectRef) {
      moveDraft(props.draftId, toggle.machineProjectRef);
    }
  };

  return (
    <Select
      modal={false}
      value={toggle.on ? SANDBOX : MACHINE}
      onValueChange={onValueChange}
      items={items}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 shrink"
              aria-label="Sandbox"
              data-composer-context-control
            />
          }
        >
          {toggle.on ? <BoxIcon className="size-3" /> : <LaptopIcon className="size-3" />}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {toggle.on
            ? `The first message starts a new sandbox for ${toggle.repo}.`
            : "The thread runs on your machine."}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Start in</SelectGroupLabel>
          <SelectItem value={SANDBOX}>
            <span className="inline-flex items-center gap-1.5">
              <BoxIcon className="size-3" />
              New sandbox
            </span>
          </SelectItem>
          <SelectItem value={MACHINE} disabled={toggle.on && toggle.machineProjectRef === null}>
            <span className="inline-flex items-center gap-1.5">
              <LaptopIcon className="size-3" />
              Your machine
            </span>
          </SelectItem>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
