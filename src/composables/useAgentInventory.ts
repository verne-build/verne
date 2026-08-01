import { computed, readonly, ref } from "vue";
import { listen, type UnlistenFn } from "@/platform";
import { useRpc } from "@/composables/useRpc";
import type { AgentInventorySnapshot } from "@/types";

const snapshot = ref<AgentInventorySnapshot | null>(null);
const loading = ref(false);

let initialized = false;
let generation = 0;
let lifecycle = 0;
let unlisten: UnlistenFn | null = null;

function commitPushedSnapshot(next: AgentInventorySnapshot): void {
  generation += 1;
  snapshot.value = next;
  loading.value = false;
}

function start(): void {
  if (initialized) return;
  initialized = true;
  const currentLifecycle = ++lifecycle;

  void listen<AgentInventorySnapshot>("agent-inventory-changed", (event) => {
    commitPushedSnapshot(event.payload);
  }).then((nextUnlisten) => {
    if (!initialized || lifecycle !== currentLifecycle) {
      nextUnlisten();
      return;
    }
    unlisten = nextUnlisten;
  }).catch((error) => {
    console.error("[agent-inventory] listen failed", error);
  });

  const requestGeneration = generation;
  loading.value = true;
  void useRpc().request.agentInventoryGet().then((next) => {
    if (!initialized || generation !== requestGeneration) return;
    snapshot.value = next;
  }).catch((error) => {
    console.error("[agent-inventory] get failed", error);
  }).finally(() => {
    if (initialized && generation === requestGeneration) loading.value = false;
  });
}

export async function refresh(): Promise<AgentInventorySnapshot> {
  start();
  const requestGeneration = generation;
  loading.value = true;
  try {
    const next = await useRpc().request.agentInventoryRefresh();
    if (initialized && generation === requestGeneration) snapshot.value = next;
    return next;
  } finally {
    if (initialized && generation === requestGeneration) loading.value = false;
  }
}

export function useAgentInventory() {
  start();
  return {
    snapshot: readonly(snapshot),
    loading: readonly(loading),
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
  lifecycle += 1;
  generation += 1;
  initialized = false;
  unlisten?.();
  unlisten = null;
  snapshot.value = null;
  loading.value = false;
}
