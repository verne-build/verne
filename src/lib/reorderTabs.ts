/**
 * Reorder `list` so its items follow the order of `ids`. Ids not present in
 * `list` are ignored. Returns null when the recognized ids don't cover every
 * item in `list` (caller should treat that as "no change"). Pure: never mutates
 * the input.
 */
export function reorderById<T extends { id: string }>(list: T[], ids: string[]): T[] | null {
  const byId = new Map(list.map(t => [t.id, t]));
  const next: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) next.push(item);
  }
  if (next.length !== list.length) return null;
  return next;
}
