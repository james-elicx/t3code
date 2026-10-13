import { FileDiffIcon } from "lucide-react";

import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import { Button } from "./ui/button";

interface ThreadReviewActionsProps {
  /** Opens the thread's diff in the right panel. Absent when the thread has no diff to show. */
  onOpenDiff?: (() => void) | undefined;
  /** Opens the thread's pull request in the right panel. Absent when it has none. */
  onOpenPullRequest?: (() => void) | undefined;
}

/** Header buttons that open the thread's diff and its pull request. */
export function ThreadReviewActions({ onOpenDiff, onOpenPullRequest }: ThreadReviewActionsProps) {
  return (
    <>
      {onOpenDiff ? (
        <Button variant="outline" size="xs" onClick={onOpenDiff} aria-label="View diff">
          <FileDiffIcon aria-hidden className="size-3.5" />
          <span className="hidden @lg/chat-header:inline">View diff</span>
        </Button>
      ) : null}
      {onOpenPullRequest ? (
        <Button variant="outline" size="xs" onClick={onOpenPullRequest} aria-label="View PR">
          <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
          <span className="hidden @lg/chat-header:inline">View PR</span>
        </Button>
      ) : null}
    </>
  );
}
