// Single source of truth for resizable panel sizing (pixels).
// Update here to change min/max/defaults across App, RightPanel, NotesPanel.
export const PANEL_SIZES = {
  /** Left sidebar (workspaces / agents). */
  left: { default: 240, min: 185, max: 420 },
  /** Right panel (files / editor). No upper bound — center's min is the backstop. */
  right: { default: 600, min: 500, max: Infinity },
  /** Center (terminal / agent) area. Hard px floor, independent of window width. */
  center: { min: 500 },
  /** Inner list panels — shared min/max; per-list default widths. */
  list: {
    min: 185,
    max: 600,
    defaults: { explorer: 200, changes: 200, history: 200, notes: 200, search: 200 },
  },
} as const;
