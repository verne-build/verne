import { ref } from "vue";

const activeCategory = ref<string>("appearance");

export function useSettingsNav() {
  return { activeCategory };
}
