const LEGACY_STORAGE_PREFIX = "t3code";
const VERNE_STORAGE_PREFIX = "verne";

/** Copies legacy browser values only when the corresponding Verne key is absent. */
export function migrateLegacyBrowserStorage(storage: Storage): number {
  const legacyKeys = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter((key): key is string => key !== null && key.startsWith(LEGACY_STORAGE_PREFIX));
  let imported = 0;

  for (const legacyKey of legacyKeys) {
    const verneKey = VERNE_STORAGE_PREFIX + legacyKey.slice(LEGACY_STORAGE_PREFIX.length);
    if (storage.getItem(verneKey) !== null) continue;
    const value = storage.getItem(legacyKey);
    if (value === null) continue;
    storage.setItem(verneKey, value);
    imported += 1;
  }

  return imported;
}
