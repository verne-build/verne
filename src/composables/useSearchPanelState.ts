import { computed, ref, type Ref } from "vue";
import type { ContentSearchMatch } from "./useRpc";

export function searchMatchKey(m: ContentSearchMatch): string {
  return `${m.relPath}:${m.line}:${m.column}`;
}

interface SearchPanelBucket {
  query: Ref<string>;
  caseSensitive: Ref<boolean>;
  include: Ref<string>;
  exclude: Ref<string>;
  showOptions: Ref<boolean>;
  results: Ref<ContentSearchMatch[]>;
  truncated: Ref<boolean>;
  selectedKey: Ref<string | null>;
  collapsedFiles: Ref<Set<string>>;
  searching: Ref<boolean>;
}

const byScope = new Map<string, SearchPanelBucket>();

function bucketFor(scopeKey: string): SearchPanelBucket {
  let b = byScope.get(scopeKey);
  if (!b) {
    b = {
      query: ref(""),
      caseSensitive: ref(false),
      include: ref(""),
      exclude: ref(""),
      showOptions: ref(false),
      results: ref([]),
      truncated: ref(false),
      selectedKey: ref(null),
      collapsedFiles: ref(new Set<string>()),
      searching: ref(false),
    };
    byScope.set(scopeKey, b);
  }
  return b;
}

function field<T>(scopeKey: Ref<string>, read: (b: SearchPanelBucket) => T, write: (b: SearchPanelBucket, v: T) => void) {
  return computed<T>({
    get: () => read(bucketFor(scopeKey.value)),
    set: (v) => write(bucketFor(scopeKey.value), v),
  });
}

export function useSearchPanelState(scopeKey: Ref<string>) {
  const query = field(scopeKey, b => b.query.value, (b, v) => { b.query.value = v; });
  const caseSensitive = field(scopeKey, b => b.caseSensitive.value, (b, v) => { b.caseSensitive.value = v; });
  const include = field(scopeKey, b => b.include.value, (b, v) => { b.include.value = v; });
  const exclude = field(scopeKey, b => b.exclude.value, (b, v) => { b.exclude.value = v; });
  const showOptions = field(scopeKey, b => b.showOptions.value, (b, v) => { b.showOptions.value = v; });
  const results = field(scopeKey, b => b.results.value, (b, v) => { b.results.value = v; });
  const truncated = field(scopeKey, b => b.truncated.value, (b, v) => { b.truncated.value = v; });
  const searching = field(scopeKey, b => b.searching.value, (b, v) => { b.searching.value = v; });

  const selected = computed<ContentSearchMatch | null>({
    get() {
      const b = bucketFor(scopeKey.value);
      if (!b.selectedKey.value) return null;
      return b.results.value.find(m => searchMatchKey(m) === b.selectedKey.value) ?? null;
    },
    set(m: ContentSearchMatch | null) {
      const b = bucketFor(scopeKey.value);
      b.selectedKey.value = m ? searchMatchKey(m) : null;
    },
  });

  function isFileCollapsed(relPath: string): boolean {
    return bucketFor(scopeKey.value).collapsedFiles.value.has(relPath);
  }

  function toggleFileCollapsed(relPath: string) {
    const b = bucketFor(scopeKey.value);
    const next = new Set(b.collapsedFiles.value);
    if (next.has(relPath)) next.delete(relPath);
    else next.add(relPath);
    b.collapsedFiles.value = next;
  }

  function resetCollapsedFiles() {
    bucketFor(scopeKey.value).collapsedFiles.value = new Set<string>();
  }

  return {
    query,
    caseSensitive,
    include,
    exclude,
    showOptions,
    results,
    truncated,
    searching,
    selected,
    isFileCollapsed,
    toggleFileCollapsed,
    resetCollapsedFiles,
  };
}
