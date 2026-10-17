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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { DraftId } from "../composerDraftStore";
import { SANDBOX_INSTANCES, type SandboxInstance } from "./directory";
import { setSandboxChoice } from "./toggle";
import { useSandboxToggle } from "./useSandboxToggle";

const OFF = "off";

function instanceLabel(instance: SandboxInstance) {
  return SANDBOX_INSTANCES.length === 1 ? "Sandbox" : `Sandbox · ${instance}`;
}

/**
 * The composer's sandbox toggle for a draft: off sends the first message to
 * the machine the draft is on; a size starts a new sandbox for the project's
 * repository. Renders nothing outside sandbox mode.
 */
export const SandboxToggleControl = memo(function SandboxToggleControl(props: {
  draftId: DraftId;
  projectRef: ScopedProjectRef;
}) {
  const { toggle, choice, instance } = useSandboxToggle(props.draftId, props.projectRef);
  const composerFloatingLayerProps = useComposerMenuProps();
  const items = useMemo(
    () => [
      { value: OFF, label: "No sandbox" },
      ...SANDBOX_INSTANCES.map((value) => ({ value, label: instanceLabel(value) })),
    ],
    [],
  );

  if (toggle.kind === "hidden") return null;
  if (toggle.kind !== "choose") {
    const row = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        <BoxIcon className="size-3" />
        <ComposerContextLabel>
          {toggle.kind === "locked" && instance ? instanceLabel(instance) : "No sandbox"}
        </ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={row} />
        <TooltipPopup>
          {toggle.kind === "locked"
            ? `A sandbox holds one thread, so this one starts a new sandbox for ${toggle.repo}.`
            : toggle.reason}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={choice ?? OFF}
      onValueChange={(value: string | null) =>
        setSandboxChoice(
          props.draftId,
          SANDBOX_INSTANCES.find((candidate) => candidate === value) ?? null,
        )
      }
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
          {choice ? <BoxIcon className="size-3" /> : <LaptopIcon className="size-3" />}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {choice
            ? `The first message starts a new sandbox for ${toggle.repo}.`
            : "The thread runs on this machine."}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Start in</SelectGroupLabel>
          <SelectItem value={OFF}>
            <span className="inline-flex items-center gap-1.5">
              <LaptopIcon className="size-3" />
              No sandbox
            </span>
          </SelectItem>
          {SANDBOX_INSTANCES.map((value) => (
            <SelectItem key={value} value={value}>
              <span className="inline-flex items-center gap-1.5">
                <BoxIcon className="size-3" />
                {instanceLabel(value)}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
