/** Which first-run surface the center pane should show when no tab is open. */
export type FirstRunView = "hero" | "picker" | "none";

export interface FirstRunInput {
  /** Has the initial getDirectories() resolved at least once? */
  directoriesLoaded: boolean;
  /** Number of working directories known to the store. */
  directoryCount: number;
  /** Is a directory currently selected (normal app shown)? */
  hasSelection: boolean;
  /** Has the user dismissed/seen the brand welcome before? */
  welcomeSeen: boolean;
}

export function firstRunView(i: FirstRunInput): FirstRunView {
  if (i.hasSelection) return "none";
  if (!i.directoriesLoaded) return "none";
  if (i.directoryCount === 0 && !i.welcomeSeen) return "hero";
  return "picker";
}
