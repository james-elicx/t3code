import { ArrowLeftIcon, FileDiffIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Toggle, ToggleGroup } from "../ui/toggle-group";

/**
 * The compact facts row under the header. The loading ghost renders the same row, so the detail
 * lands without moving anything.
 */
export function PullRequestDetailMetaRow({
  author,
  updated,
  base,
  head,
  files,
  filesLabel,
  diffStat,
}: {
  author: ReactNode;
  updated: ReactNode;
  base: ReactNode;
  head: ReactNode;
  files: ReactNode;
  filesLabel?: string | undefined;
  diffStat: ReactNode;
}) {
  return (
    <div className="col-span-2 min-w-0 px-4 pb-2 pt-1">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
          {author}
          {updated}
        </span>
        <span aria-hidden className="h-3 w-px shrink-0 bg-border/70" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-2xs text-muted-foreground/65">
          {base}
          <ArrowLeftIcon
            aria-label="receives changes from"
            className="size-3 shrink-0 opacity-60"
          />
          {head}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2 text-2xs">
          <span className="inline-flex items-center gap-1 tabular-nums" aria-label={filesLabel}>
            <FileDiffIcon aria-hidden className="size-3" />
            {files}
          </span>
          {diffStat}
        </span>
      </div>
    </div>
  );
}

export function PullRequestDetailTabBar<Tab extends string>({
  tabs,
  value,
  onValueChange,
  onTabIntent,
  inert,
  children,
}: {
  tabs: ReadonlyArray<{ readonly value: Tab; readonly label: string }>;
  value: Tab;
  onValueChange?: (tab: Tab) => void;
  onTabIntent?: (tab: Tab) => void;
  inert?: boolean;
  children?: ReactNode;
}) {
  return (
    <nav
      className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2"
      aria-label="Pull request tabs"
      inert={inert}
    >
      <ToggleGroup
        className="shrink-0"
        size="segmented"
        variant="segmented"
        value={[value]}
        onValueChange={(next) => {
          const nextTab = tabs.find((item) => item.value === next[0])?.value;
          if (nextTab) onValueChange?.(nextTab);
        }}
      >
        {tabs.map((tab) => (
          <Toggle
            key={tab.value}
            value={tab.value}
            onPointerEnter={onTabIntent ? () => onTabIntent(tab.value) : undefined}
            onFocus={onTabIntent ? () => onTabIntent(tab.value) : undefined}
          >
            {tab.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {children}
    </nav>
  );
}

export function PullRequestChecksStatusLine({
  icon,
  label,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & { icon: ReactNode; label: ReactNode }) {
  return (
    <span
      className={cn(
        "ml-auto flex h-4 min-w-0 flex-1 flex-wrap content-start items-center justify-end gap-x-1.5 overflow-hidden text-xs",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}
