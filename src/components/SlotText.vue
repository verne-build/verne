<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

// Animation model adapted from Danilaa1/slot-text (MIT).
type SlotColor = string | ((index: number, total: number) => string);
interface SlotOptions {
  direction?: "up" | "down";
  stagger?: number;
  duration?: number;
  exitOffset?: number;
  easing?: string;
  bounce?: number;
  color?: SlotColor;
  colorFade?: number;
  skipUnchanged?: boolean;
  interrupt?: boolean;
}

const props = withDefaults(defineProps<{
  text: string;
  direction?: "up" | "down";
  options?: SlotOptions;
}>(), {
  direction: "down",
});

const root = ref<HTMLElement | null>(null);
const timers: number[] = [];
let pending: { text: string; options: SlotOptions } | null = null;
let activeTarget = props.text;

const DEFAULTS = {
  direction: "down" as const,
  stagger: 45,
  duration: 300,
  exitOffset: 50,
  easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  bounce: 0.6,
  colorFade: 280,
  skipUnchanged: true,
  interrupt: true,
};

const NBSP = "\u00A0";
const glyph = (char: string) => (char === " " ? NBSP : char);

function clearTimers() {
  for (const timer of timers.splice(0)) window.clearTimeout(timer);
}

function makeFace(char: string) {
  const face = document.createElement("span");
  face.className = "slot-text-face";
  face.textContent = glyph(char);
  return face;
}

function makeSlot(char: string) {
  const slot = document.createElement("span");
  slot.className = "slot-text-slot";
  slot.dataset.char = char;

  const sizer = document.createElement("span");
  sizer.className = "slot-text-sizer";
  sizer.textContent = glyph(char);

  slot.append(sizer, makeFace(char));
  return slot;
}

function build(text: string) {
  if (!root.value) return;
  activeTarget = text;
  root.value.replaceChildren(...Array.from(text, makeSlot));
}

function animate(toText: string, rawOptions: SlotOptions = {}) {
  const el = root.value;
  if (!el) return;

  const options = { ...DEFAULTS, ...rawOptions };
  const wasRunning = timers.length > 0;
  if (wasRunning && !options.interrupt) {
    if (toText !== activeTarget) pending = { text: toText, options };
    return;
  }

  clearTimers();
  if (wasRunning) build(activeTarget);

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const existing = Array.from(el.querySelectorAll<HTMLElement>(".slot-text-slot"));
  if (prefersReducedMotion || existing.length === 0) {
    build(toText);
    return;
  }

  const fromText = existing.map((slot) => slot.dataset.char ?? "").join("");
  if (fromText === toText) return;

  const slots = [...existing];
  activeTarget = toText;
  const maxLen = Math.max(fromText.length, toText.length);
  for (let index = slots.length; index < maxLen; index++) {
    const slot = makeSlot("");
    el.append(slot);
    slots.push(slot);
  }

  const sample = slots.find((slot) => (slot.dataset.char ?? "") !== "") ?? slots[0];
  const styles = getComputedStyle(el);
  const height =
    Math.ceil(
      sample?.getBoundingClientRect().height ||
      el.getBoundingClientRect().height ||
      parseFloat(styles.lineHeight) ||
      0,
    ) ||
    Math.ceil(parseFloat(styles.fontSize) * 1.3) ||
    18;

  const restColor = options.color ? styles.color : "";
  const outY = options.direction === "down" ? height : -height;
  const inStart = options.direction === "down" ? -height : height;
  let lastEnd = 0;

  const wobble = (index: number, salt: number) => {
    const n = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1;
  };

  for (let index = 0; index < maxLen; index++) {
    const fromChar = fromText[index] ?? "";
    const toChar = toText[index] ?? "";
    if (fromChar === toChar && (options.skipUnchanged || fromChar === "")) continue;

    const slot = slots[index];
    const sizer = slot.querySelector<HTMLElement>(".slot-text-sizer");
    const oldFace = slot.querySelector<HTMLElement>(".slot-text-face");
    if (!sizer) continue;

    const oldWidth = slot.getBoundingClientRect().width;
    sizer.textContent = glyph(toChar);
    const newWidth = sizer.getBoundingClientRect().width;
    const widthChanges = Math.abs(newWidth - oldWidth) > 0.5;
    if (widthChanges) slot.style.width = `${oldWidth}px`;
    if (fromChar === "" || toChar === "") slot.classList.add("is-resizing");

    const isTail = toChar === "";
    const letterDuration = Math.round(
      options.duration * (isTail ? 0.75 : 1) * (1 + options.bounce * 0.45 * wobble(index, 1)),
    );
    const staggerIndex = isTail
      ? toText.length * 0.5 + (index - toText.length) * 0.25
      : index;
    const baseDelay = Math.max(
      0,
      Math.round(staggerIndex * options.stagger * (1 + options.bounce * 0.25 * wobble(index, 2))),
    );
    const tilt = (options.bounce * 5 * wobble(index, 3)).toFixed(2);
    const rollTransition = `transform ${letterDuration}ms ${options.easing}`;
    const transition = options.color
      ? `${rollTransition}, color ${options.colorFade}ms linear ${letterDuration}ms`
      : rollTransition;
    const tint = typeof options.color === "function" ? options.color(index, maxLen) : options.color;

    const newFace = makeFace(toChar);
    newFace.style.transformOrigin = "50% 50%";
    newFace.style.transform = `translateY(${inStart}px) rotate(${tilt}deg)`;
    if (tint) newFace.style.color = tint;
    slot.append(newFace);

    void slot.offsetWidth;

    if (widthChanges) {
      let widthDelay = baseDelay;
      let widthDuration = letterDuration;
      if (isTail) {
        widthDelay = baseDelay + Math.round(letterDuration * 0.55);
        widthDuration = Math.max(120, Math.round(letterDuration * 0.6));
      } else if (fromChar === "") {
        widthDuration = Math.max(120, Math.round(letterDuration * 0.45));
      }
      timers.push(window.setTimeout(() => {
        slot.style.transition = `width ${widthDuration}ms cubic-bezier(0.2, 0, 0, 1)`;
        slot.style.width = `${newWidth}px`;
      }, widthDelay));
      lastEnd = Math.max(lastEnd, widthDelay + widthDuration);
    }

    if (oldFace) {
      timers.push(window.setTimeout(() => {
        oldFace.style.transition = rollTransition;
        oldFace.style.transform = `translateY(${outY}px) rotate(${-Number(tilt)}deg)`;
      }, baseDelay));
    }

    timers.push(window.setTimeout(() => {
      newFace.style.transition = transition;
      newFace.style.transform = "translateY(0) rotate(0deg)";
      if (options.color) newFace.style.color = restColor;

      const done = (event: TransitionEvent) => {
        if (event.propertyName !== "transform") return;
        newFace.removeEventListener("transitionend", done);
        slot.dataset.char = toChar;
        slot.style.removeProperty("transition");
        slot.style.removeProperty("width");
        slot.classList.remove("is-resizing");
        slot.querySelectorAll(".slot-text-face").forEach((face) => {
          if (face !== newFace) face.remove();
        });
      };
      newFace.addEventListener("transitionend", done);
    }, baseDelay + options.exitOffset));

    lastEnd = Math.max(
      lastEnd,
      baseDelay + options.exitOffset + letterDuration + (options.color ? options.colorFade : 0),
    );
  }

  timers.push(window.setTimeout(() => {
    const next = pending;
    pending = null;
    build(toText);
    if (next) animate(next.text, next.options);
  }, lastEnd + 80));
}

onMounted(() => {
  build(props.text);
});

watch(
  () => [props.text, props.direction, props.options] as const,
  ([text, direction, options]) => animate(text, { direction, ...options }),
);

onBeforeUnmount(() => {
  clearTimers();
});
</script>

<template>
  <span ref="root" class="slot-text" :aria-label="text" />
</template>

<style scoped>
.slot-text {
  display: inline-flex;
  white-space: pre;
}

.slot-text :deep(.slot-text-slot) {
  position: relative;
  display: inline-flex;
  flex: none;
  justify-content: center;
  overflow: hidden;
  overflow-x: visible;
  overflow-y: clip;
  line-height: 1.3;
  vertical-align: bottom;
}

.slot-text :deep(.slot-text-slot.is-resizing) {
  overflow-x: clip;
}

.slot-text :deep(.slot-text-sizer) {
  visibility: hidden;
  white-space: pre;
}

.slot-text :deep(.slot-text-face) {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: pre;
  will-change: transform;
}
</style>
