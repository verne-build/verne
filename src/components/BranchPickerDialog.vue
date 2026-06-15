<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { GitBranch } from "@/types";
import { useRpc } from "@/composables/useRpc";
import { toast } from "vue-sonner";
import { GitBranch as GitBranchIcon, Cloud, Check, Plus, GitFork } from "@lucide/vue";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  open: boolean;
  workingPath: string;
  currentBranch: string;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "branch-changed"): void;
}>();

const { request } = useRpc();
const branches = ref<GitBranch[]>([]);

type PickerMode = "default" | "pick-base" | "name-input";
const pickerMode = ref<PickerMode>("default");
const selectedBase = ref<string | null>(null);
const newBranchName = ref("");
const localBranches = computed(() => branches.value.filter((b) => !b.isRemote));
const remoteBranches = computed(() => branches.value.filter((b) => b.isRemote));
let branchFetchGeneration = 0;

async function fetchBranches() {
  const generation = ++branchFetchGeneration;
  const workingPath = props.workingPath;
  try {
    const next = await request.gitListBranches({ path: workingPath });
    if (generation === branchFetchGeneration && workingPath === props.workingPath) {
      branches.value = next;
    }
  } catch (e) {
    if (generation !== branchFetchGeneration || workingPath !== props.workingPath) return;
    console.error("list branches:", e);
    branches.value = [];
  }
}

function setOpen(v: boolean) {
  emit("update:open", v);
}

function onOpenChange(isOpen: boolean) {
  setOpen(isOpen);
  if (isOpen) {
    pickerMode.value = "default";
    fetchBranches();
  }
}

function friendlyError(e: unknown): string {
  let msg = String(e);
  const lastError = msg.lastIndexOf("Error:");
  if (lastError >= 0) msg = msg.slice(lastError + 6).trim();
  return msg.replace(/^(checkout|create branch) failed:\s*/i, "");
}

async function checkout(branch: GitBranch) {
  if (branch.isHead) return;
  try {
    const remoteRef = branch.isRemote
      ? branch.fullRef.replace("refs/remotes/", "")
      : undefined;
    await request.gitCheckoutBranch({
      path: props.workingPath,
      name: branch.name,
      isRemote: branch.isRemote,
      remoteRef,
    });
    emit("branch-changed");
  } catch (e) {
    toast.error(friendlyError(e), { duration: 5000 });
  }
  setOpen(false);
}

function startNewBranch() {
  selectedBase.value = null;
  newBranchName.value = "";
  pickerMode.value = "name-input";
}

function startNewBranchFrom() {
  pickerMode.value = "pick-base";
}

function selectBase(branch: GitBranch) {
  selectedBase.value = branch.isRemote ? branch.fullRef.replace("refs/remotes/", "") : branch.name;
  newBranchName.value = "";
  pickerMode.value = "name-input";
}

async function confirmCreateBranch() {
  const name = newBranchName.value.trim();
  if (!name) return;
  try {
    await request.gitCreateBranch({
      path: props.workingPath,
      name,
      fromRef: selectedBase.value ?? undefined,
    });
    emit("branch-changed");
  } catch (e) {
    toast.error(friendlyError(e), { duration: 5000 });
  }
  setOpen(false);
}

watch(() => props.workingPath, () => {
  if (props.open) fetchBranches();
});

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    pickerMode.value = "default";
    fetchBranches();
  }
});
</script>

<template>
  <CommandDialog :open="props.open" @update:open="onOpenChange" :ignore-filter="pickerMode === 'name-input'">
    <!-- Default: branch picker -->
    <template v-if="pickerMode === 'default'">
      <CommandInput placeholder="Search branches..." />
      <CommandList>
        <CommandEmpty>No branches found</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem value="new-branch" @select="startNewBranch">
            <Plus class="mr-2 size-3.5" />
            New Branch
          </CommandItem>
          <CommandItem value="new-branch-from" @select="startNewBranchFrom">
            <GitFork class="mr-2 size-3.5" />
            New Branch From...
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup v-if="localBranches.length" heading="Local">
          <CommandItem
            v-for="b in localBranches"
            :key="b.fullRef"
            :value="b.fullRef"
            @select="checkout(b)"
          >
            <GitBranchIcon class="mr-2 size-3.5 shrink-0" />
            <span class="flex-1 truncate">{{ b.name }}</span>
            <Check v-if="b.isHead" class="ml-2 size-3.5 shrink-0" />
          </CommandItem>
        </CommandGroup>
        <CommandGroup v-if="remoteBranches.length" heading="Remote">
          <CommandItem
            v-for="b in remoteBranches"
            :key="b.fullRef"
            :value="b.fullRef"
            @select="checkout(b)"
          >
            <Cloud class="mr-2 size-3.5 shrink-0" />
            <span class="flex-1 truncate">{{ b.name }}</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </template>

    <!-- Pick base branch for "New Branch From..." -->
    <template v-else-if="pickerMode === 'pick-base'">
      <CommandInput placeholder="Select base branch..." />
      <CommandList>
        <CommandEmpty>No branches found</CommandEmpty>
        <CommandGroup v-if="localBranches.length" heading="Local">
          <CommandItem
            v-for="b in localBranches"
            :key="b.fullRef"
            :value="b.fullRef"
            @select="selectBase(b)"
          >
            <GitBranchIcon class="mr-2 size-3.5 shrink-0" />
            {{ b.name }}
          </CommandItem>
        </CommandGroup>
        <CommandGroup v-if="remoteBranches.length" heading="Remote">
          <CommandItem
            v-for="b in remoteBranches"
            :key="b.fullRef"
            :value="b.fullRef"
            @select="selectBase(b)"
          >
            <Cloud class="mr-2 size-3.5 shrink-0" />
            {{ b.name }}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </template>

    <!-- Name input for new branch -->
    <template v-else-if="pickerMode === 'name-input'">
      <div class="p-4">
        <p class="mb-1 text-sm font-medium text-foreground">New Branch</p>
        <p class="mb-3 text-xs text-muted-foreground">
          {{ selectedBase ? `From ${selectedBase}` : `From current branch (${currentBranch})` }}
        </p>
        <input
          v-model="newBranchName"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          class="w-full rounded border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          placeholder="branch-name"
          @keydown.enter="confirmCreateBranch"
          @keydown.escape="setOpen(false)"
          @vue:mounted="({ el }: any) => el.focus()"
        />
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" @click="pickerMode = 'default'">Back</Button>
          <Button size="sm" :disabled="!newBranchName.trim()" @click="confirmCreateBranch">Create</Button>
        </div>
      </div>
    </template>
  </CommandDialog>
</template>
