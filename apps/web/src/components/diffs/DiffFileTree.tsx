import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreePositions,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

/**
 * Diff trees sit in a narrow column, so the names get the room: the inline inset lines rows up
 * with the "Files" label instead of Pierre's roomier default, and a flattened folder chain gives
 * up its leading segments before the deepest one, which is the one that says where you are.
 */
const DIFF_TREE_UNSAFE_CSS = `${PIERRE_TREE_UNSAFE_CSS}
  :host { --trees-padding-inline-override: 6px; }
  [data-item-flattened-subitems] { display: flex; min-width: 0; overflow: hidden; white-space: nowrap; }
  [data-item-flattened-subitem] { flex: 0 1 auto; min-width: 1em; }
  [data-item-flattened-subitem]:last-of-type { flex-shrink: 0.2; min-width: 2em; }
`;

const ROW_TOOLTIP_DELAY_MS = 500;

interface HoveredTreeRow {
  readonly anchor: Element;
  readonly path: string;
}

function hoveredTreeRow(event: Event): HoveredTreeRow | null {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    const path = node.getAttribute("data-item-path");
    if (path !== null) return { anchor: node, path: path.replace(/\/$/, "") };
  }
  return null;
}

/**
 * The full path of the tree row under the pointer, since a narrow tree shortens its names. The
 * rows live in Pierre's shadow root, so this listens on the container and anchors to the row
 * element itself; hovering never re-renders the tree.
 */
function FileTreeRowTooltip({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const [row, setRow] = useState<(HoveredTreeRow & { readonly showId: number }) | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let timer: number | null = null;
    let hoveredPath: string | null = null;
    let shown = false;
    let showId = 0;
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const show = (next: HoveredTreeRow) => {
      shown = true;
      showId += 1;
      setRow({ ...next, showId });
      setOpen(true);
    };
    const hide = () => {
      clearTimer();
      hoveredPath = null;
      shown = false;
      setOpen(false);
    };
    const handlePointerMove = (event: PointerEvent) => {
      const next = hoveredTreeRow(event);
      // Moving within a row keeps its pending delay or open tooltip.
      if (next?.path === hoveredPath) return;
      if (next === null) return hide();
      hoveredPath = next.path;
      clearTimer();
      // Once a path is showing, the next row answers at once, like a tooltip group.
      if (shown) return show(next);
      timer = window.setTimeout(() => show(next), ROW_TOOLTIP_DELAY_MS);
    };
    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerleave", hide);
    container.addEventListener("pointerdown", hide);
    // Virtualized rows are reused as the tree scrolls, so the anchor would point at another file.
    container.addEventListener("wheel", hide, { passive: true });
    return () => {
      clearTimer();
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerleave", hide);
      container.removeEventListener("pointerdown", hide);
      container.removeEventListener("wheel", hide);
    };
  }, [containerRef]);

  if (row === null) return null;
  // Keyed per show: an open tooltip does not follow a new anchor, so each one positions fresh.
  return <TreeRowPathTooltip key={row.showId} anchor={row.anchor} open={open} path={row.path} />;
}

function TreeRowPathTooltip({
  anchor,
  open,
  path,
}: {
  anchor: Element;
  open: boolean;
  path: string;
}) {
  const [mounted, setMounted] = useState(false);
  // oxlint-disable-next-line react/set-state-in-effect -- Opens one render after mounting: Base UI only skips its slide-from-origin position transition when a mounted tooltip goes from closed to open.
  useEffect(() => setMounted(true), []);
  return (
    <Tooltip open={open && mounted}>
      <TooltipPopup anchor={anchor} side="left" variant="code">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly onSelectFile: (path: string) => void;
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  readonly headerAccessory?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function DiffFileTree({
  entries,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  headerAccessory,
  footer,
  className,
}: DiffFileTreeProps) {
  const { resolvedTheme } = useTheme();
  const paths = entries.map((entry) => entry.path);
  const directoryPaths = collectDirectoryPaths(paths);
  const positions = diffFileTreePositions(paths);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus: ReadonlyArray<GitStatusEntry> = entries.map((entry) => ({
    path: entry.path,
    status: entry.status,
  }));
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{ path: string; revealRequestId: number } | null>(null);
  const mountedPathsRef = useRef<ReadonlyArray<string> | null>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const path = selectedPaths.at(-1)?.replace(/\/$/, "");
    if (path && paths.includes(path)) onSelectFile(path);
  });

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: handleSelectionChange,
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: DIFF_TREE_UNSAFE_CSS,
  });
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );

  useEffect(() => {
    ordering.update(positions);
    const mountedPaths = mountedPathsRef.current;
    if (mountedPaths === paths) return;
    mountedPathsRef.current = paths;
    if (mountedPaths === null) {
      model.resetPaths(paths);
    } else if (mountedPaths.every((path, index) => paths[index] === path)) {
      const updates = buildDiffFileTreeUpdates(mountedPaths, paths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A refreshed diff can change the rank of existing siblings. Mutations do not reorder
      // those rows, so rebuild while carrying the reader's folder expansion forward.
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      model.resetPaths(paths);
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, ordering, paths, positions]);

  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    const item = model.getItem(selectedPath);
    if (item === null || item.isDirectory()) {
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === selectedPath && handled.revealRequestId === revealRequestId) return;
    handledRevealRef.current = { path: selectedPath, revealRequestId };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedPath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of selectedPath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(selectedPath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [
    model,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A file that arrives after it was asked for is still revealed.
    paths,
    revealRequestId,
    selectedPath,
  ]);

  return (
    <div
      ref={treeContainerRef}
      className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">Files</span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {headerAccessory}
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={() =>
                    setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                  }
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
              />
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <FileTree
        model={model}
        aria-label={ariaLabel}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          // Pierre does not emit a selection change for its sole selected row.
          // Read selection before the row handles the click so new selections reveal only once.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !paths.includes(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          if (clickedSelectedRow) onSelectFile(path);
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
      <FileTreeRowTooltip containerRef={treeContainerRef} />
      {footer}
    </div>
  );
}
