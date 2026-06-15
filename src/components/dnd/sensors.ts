import { PointerSensor, KeyboardSensor } from "@dnd-kit/vue";

const NO_DRAG_SELECTOR =
  'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[contenteditable]:not([contenteditable="false"]),[data-no-drag],[data-no-drag] *';

const ConfiguredPointer = PointerSensor.configure({
  preventActivation(event) {
    const t = event.target as Element | null;
    if (!t || !(t instanceof Element)) return false;
    return !!t.closest(NO_DRAG_SELECTOR);
  },
});

export const sortableSensors = [ConfiguredPointer, KeyboardSensor];
