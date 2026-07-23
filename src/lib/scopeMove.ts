import type { Tab } from "@/types";

/** Pure cross-scope bucket move: relocate tabId from `from`'s bucket to
 *  `to`'s, appending it and stamping the new directoryId+cwd. No-op (same
 *  reference back) if the tab isn't in `from`'s bucket. */
export function moveTabBetweenBuckets(
  buckets: Record<string, Tab[]>,
  tabId: string,
  from: string,
  to: string,
  cwd: string,
): Record<string, Tab[]> {
  const tab = (buckets[from] ?? []).find((t) => t.id === tabId);
  if (!tab) return buckets;
  return {
    ...buckets,
    [from]: (buckets[from] ?? []).filter((t) => t.id !== tabId),
    [to]: [...(buckets[to] ?? []), { ...tab, directoryId: to, cwd }],
  };
}
