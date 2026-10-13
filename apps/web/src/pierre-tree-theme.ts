import type { CSSProperties } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    /* Opaque so a truncated name's ellipsis marker can cover the clipped text; the trees sit on
       the app background. */
    --trees-bg-override: var(--background);
    /* Mixed from the tree's foreground, not currentColor: the truncation marker repaints these
       inside a name tinted by its git status, and must match the row behind it. */
    --trees-selected-bg-override: color-mix(in srgb, var(--trees-fg) 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, var(--trees-fg) 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
  svg[data-icon-name='t3-tree-icon-loading'] { opacity: 0.6; }
  @media (prefers-reduced-motion: no-preference) {
    svg[data-icon-name='t3-tree-icon-loading'] { animation: t3-tree-spin 1s linear infinite; }
  }
  @keyframes t3-tree-spin { to { transform: rotate(360deg); } }
`;

export function pierreTreeStyle(colorScheme: "light" | "dark"): CSSProperties {
  return {
    colorScheme,
    ["--trees-fg-override" as string]: "var(--contrast-foreground)",
  };
}
