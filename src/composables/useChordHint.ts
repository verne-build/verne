import { ref } from "vue";

const chordHint = ref("");
let chordTimer: ReturnType<typeof setTimeout> | null = null;

export function useChordHint() {
  function showChord(key: string) {
    chordHint.value = `(${key}) was pressed. Waiting for second key of chord...`;
    if (chordTimer) clearTimeout(chordTimer);
    chordTimer = setTimeout(clearChord, 1500);
  }

  function clearChord() {
    chordHint.value = "";
    if (chordTimer) { clearTimeout(chordTimer); chordTimer = null; }
  }

  return { chordHint, showChord, clearChord };
}
