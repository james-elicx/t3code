import { useState } from "react";

export function useComposerFocusState() {
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  // Threads open resting; the first composer interaction expands it.
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(true);

  const restoreAfterTimelineReachedEnd = () => {
    setIsComposerScrollCollapsed(false);
  };

  return {
    isComposerFocused,
    setIsComposerFocused,
    isComposerScrollCollapsed,
    setIsComposerScrollCollapsed,
    restoreAfterTimelineReachedEnd,
  };
}
