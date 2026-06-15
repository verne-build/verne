import { ref } from "vue";

// Settings screen visibility — module singleton so non-App code (e.g. agent
// toast "View") can close it.
const showSettings = ref(false);

export function useSettingsScreen() {
  return { showSettings };
}
