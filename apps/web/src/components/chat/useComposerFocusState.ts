import { useCallback, useState } from "react";

export function useComposerFocusState() {
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  // Threads open resting; the first composer interaction expands it.
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(true);

  // Reaching the end of the timeline lifts a scroll collapse without moving
  // DOM focus to the editor.
  const restoreAfterTimelineReachedEnd = useCallback(() => {
    setIsComposerScrollCollapsed(false);
  }, []);

  return {
    isComposerFocused,
    setIsComposerFocused,
    isComposerScrollCollapsed,
    setIsComposerScrollCollapsed,
    restoreAfterTimelineReachedEnd,
  };
}
