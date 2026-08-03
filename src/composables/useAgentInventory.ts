import { computed, readonly, ref } from "vue";
import { listen, type UnlistenFn } from "@/platform";
import { useRpc } from "@/composables/useRpc";
import type { AgentInventorySnapshot } from "@/types";

const snapshot = ref<AgentInventorySnapshot | null>(null);
const loading = ref(false);

let generation = 0;
type Lifecycle = {
  operation: object | null;
  unlisten: UnlistenFn | null;
};
let lifecycle: Lifecycle | null = null;

function isCurrent(owner: Lifecycle, operation: object, requestGeneration: number): boolean {
  return lifecycle === owner && owner.operation === operation && generation === requestGeneration;
}

function beginOperation(owner: Lifecycle): { operation: object; requestGeneration: number } {
  const operation = {};
  owner.operation = operation;
  loading.value = true;
  return { operation, requestGeneration: generation };
}

function commitPushedSnapshot(owner: Lifecycle, next: AgentInventorySnapshot): void {
  if (lifecycle !== owner) return;
  generation += 1;
  owner.operation = null;
  snapshot.value = next;
  loading.value = false;
}

function start(): void {
  if (lifecycle) return;
  const owner: Lifecycle = { operation: null, unlisten: null };
  lifecycle = owner;

  void listen<AgentInventorySnapshot>("agent-inventory-changed", (event) => {
    commitPushedSnapshot(owner, event.payload);
  }).then((nextUnlisten) => {
    if (lifecycle !== owner) {
      nextUnlisten();
      return;
    }
    owner.unlisten = nextUnlisten;
  }).catch((error) => {
    console.error("[agent-inventory] listen failed", error);
  });

  const { operation, requestGeneration } = beginOperation(owner);
  void useRpc().request.agentInventoryGet().then((next) => {
    if (!isCurrent(owner, operation, requestGeneration)) return;
    snapshot.value = next;
  }).catch((error) => {
    console.error("[agent-inventory] get failed", error);
  }).finally(() => {
    if (isCurrent(owner, operation, requestGeneration)) loading.value = false;
  });
}

export async function refresh(): Promise<AgentInventorySnapshot> {
  start();
  const owner = lifecycle!;
  const { operation, requestGeneration } = beginOperation(owner);
  try {
    const next = await useRpc().request.agentInventoryRefresh();
    if (isCurrent(owner, operation, requestGeneration)) snapshot.value = next;
    return next;
  } finally {
    if (isCurrent(owner, operation, requestGeneration)) loading.value = false;
  }
}

export function useAgentInventory() {
  start();
  return {
    snapshot: readonly(snapshot),
    loading: readonly(loading),
    /** True from the first request until the last row finishes resolving. */
    refreshing: computed(() => loading.value || snapshot.value?.complete === false),
    installedKeys: computed(() => new Set(
      snapshot.value?.agents
        .filter((agent) => agent.discoveryStatus === "installed")
        .map((agent) => agent.key) ?? [],
    )),
    outdatedItems: computed(() =>
      snapshot.value?.agents.filter((agent) => agent.updateStatus === "outdated") ?? [],
    ),
    refresh,
  };
}

export function disposeAgentInventory(): void {
  const owner = lifecycle;
  lifecycle = null;
  generation += 1;
  owner?.unlisten?.();
  snapshot.value = null;
  loading.value = false;
}
