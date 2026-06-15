<script setup lang="ts">
import { Transition, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef } from "vue";

const emit = defineEmits<{ done: [] }>();

const phase = ref<"animation" | "quote" | "fadeout">("animation");
const overlayRef = ref<HTMLElement | null>(null);
const quoteRef = ref<HTMLElement | null>(null);

// --- SplashScreen animation state ---
const splashSpriteGlow = ref(false);
const splashTimeMachineEntering = ref(false);
const splashTimeMachineLaunching = ref(false);
const splashTrailVisible = ref(false);
const splashPreJumpBarVisible = ref(false);
const splashJumpFlashVisible = ref(false);
const splashSpeedometerVisible = ref(false);
const splashSpeedValue = ref(0);
let splashSparkFlickerStarted = false;
const roadContainerRef = ref<HTMLElement | null>(null);
const splashSparks = shallowRef<any[]>([]);
const splashTrailParticles = shallowRef<any[]>([]);
const splashPortalParticles = shallowRef<any[]>([]);

const ZERO_TO_SIXTY_MS = 9650;
const ZERO_TO_EIGHTY_EIGHT_MS = Math.round((ZERO_TO_SIXTY_MS * 88) / 60);
const INITIAL_SPEED_MPH = 30;
const SPARK_START_MPH = 65;
const PRE_JUMP_BAR_START_MPH = 80;
const PORTAL_IMPACT_DELAY_MS = 0;
const TRAIL_DELAY_MS = 0;
const FLASH_HIDE_DELAY_MS = 560;
const FORTY_TO_SIXTY_MS = Math.round((ZERO_TO_SIXTY_MS * (60 - INITIAL_SPEED_MPH)) / 60);
const FORTY_TO_EIGHTY_EIGHT_MS = FORTY_TO_SIXTY_MS + (ZERO_TO_EIGHTY_EIGHT_MS - ZERO_TO_SIXTY_MS);


const timeoutIds = new Set<number>();
let splashSequenceToken = 0;
let nextSparkId = 0;
let speedometerFrameId = 0;

function scheduleTimeout(callback: () => void, delay: number) {
  const timeoutId = window.setTimeout(() => {
    timeoutIds.delete(timeoutId);
    callback();
  }, delay);
  timeoutIds.add(timeoutId);
  return timeoutId;
}

function clearScheduledTimeouts() {
  timeoutIds.forEach((id) => window.clearTimeout(id));
  timeoutIds.clear();
}

function clearSpeedometerFrame() {
  if (speedometerFrameId) {
    window.cancelAnimationFrame(speedometerFrameId);
    speedometerFrameId = 0;
  }
}

function resetSplashSequence() {
  clearSpeedometerFrame();
  splashSpriteGlow.value = false;
  splashSparkFlickerStarted = false;
  splashTimeMachineEntering.value = false;
  splashTimeMachineLaunching.value = false;
  splashTrailVisible.value = false;
  splashPreJumpBarVisible.value = false;
  splashJumpFlashVisible.value = false;
  splashSpeedometerVisible.value = false;
  splashSpeedValue.value = INITIAL_SPEED_MPH;
  splashSparks.value = [];
  splashTrailParticles.value = [];
  splashPortalParticles.value = [];
}

function runSplashSequence(token: number) {
  if (token !== splashSequenceToken) return;
  resetSplashSequence();

  scheduleTimeout(() => {
    if (token !== splashSequenceToken) return;
    splashTimeMachineEntering.value = true;
    splashSpeedometerVisible.value = true;
    splashSpeedValue.value = INITIAL_SPEED_MPH;
    runSpeedometer(token, performance.now());
  }, 40);
}

function launchSplashDeLorean(token: number) {
  if (token !== splashSequenceToken) return;
  clearSpeedometerFrame();
  splashSpeedometerVisible.value = false;
  splashSpriteGlow.value = true;
  splashPreJumpBarVisible.value = false;
  splashJumpFlashVisible.value = true;
  emitPortalBurst(token);

  scheduleTimeout(() => {
    if (token !== splashSequenceToken) return;
    splashTimeMachineLaunching.value = true;
  }, PORTAL_IMPACT_DELAY_MS);

  scheduleTimeout(() => {
    if (token !== splashSequenceToken) return;
    splashTrailVisible.value = true;
    runTrailFire(token);
  }, TRAIL_DELAY_MS);

  scheduleTimeout(() => {
    if (token !== splashSequenceToken) return;
    splashJumpFlashVisible.value = false;
  }, FLASH_HIDE_DELAY_MS);

  // After the flash settles, show quote — trails keep animating out underneath
  scheduleTimeout(() => {
    if (token !== splashSequenceToken) return;
    clearSpeedometerFrame();
    startQuotePhase();
  }, 2800);
}

function emitSparkBurst(token: number) {
  if (token !== splashSequenceToken || splashTimeMachineLaunching.value) return;
  const sparkOrigins = [
    { x: -22, y: -60, dx: -1 },
    { x: 22, y: -60, dx: 1 },
    { x: -18, y: 36, dx: -1 },
    { x: 18, y: 36, dx: 1 },
  ];
  const newSparks = sparkOrigins.flatMap((origin) => {
    const burstCount = 3 + Math.floor(Math.random() * 3);
    return Array.from({ length: burstCount }, () => {
      const startX = origin.x + (Math.random() - 0.5) * 6;
      const startY = origin.y + Math.random() * 6;
      const deltaX = origin.dx * (6 + Math.random() * 16);
      const deltaY = 28 + Math.random() * 52;
      const size = 6 + Math.floor(Math.random() * 6);
      return {
        id: nextSparkId++,
        style: {
          "--spark-start-x": `${startX}px`,
          "--spark-start-y": `${startY}px`,
          "--spark-dx": `${deltaX}px`,
          "--spark-dy": `${deltaY}px`,
          "--spark-size": `${size}px`,
        },
      };
    });
  });
  splashSparks.value.push(...newSparks);
  triggerRef(splashSparks);
  scheduleTimeout(() => {
    if (token !== splashSequenceToken) return;
    const expiredIds = new Set(newSparks.map((s) => s.id));
    splashSparks.value = splashSparks.value.filter((s) => !expiredIds.has(s.id));
  }, 420);
}

function runSparkFlicker(token: number) {
  if (token !== splashSequenceToken || splashTimeMachineLaunching.value) return;
  const nearJump = splashSpeedValue.value >= 80;
  const flickerChance = nearJump ? 0.82 : 0.58;
  splashSpriteGlow.value = Math.random() < flickerChance;
  if (splashSpriteGlow.value) {
    emitSparkBurst(token);
    if (nearJump && Math.random() > 0.45) emitSparkBurst(token);
  }
  const nextDelay = splashSpriteGlow.value
    ? nearJump
      ? 28 + Math.floor(Math.random() * 45)
      : 45 + Math.floor(Math.random() * 70)
    : nearJump
      ? 20 + Math.floor(Math.random() * 55)
      : 35 + Math.floor(Math.random() * 120);
  scheduleTimeout(() => runSparkFlicker(token), nextDelay);
}

function emitTrailFireBurst(token: number) {
  if (token !== splashSequenceToken || !splashTrailVisible.value) return;
  const trackCenters = [6.5, 61.5];
  const newParticles = Array.from({ length: 12 }, () => {
    const center = trackCenters[Math.floor(Math.random() * trackCenters.length)];
    const size = 3 + Math.floor(Math.random() * 4);
    const startX = center - size / 2 + (Math.random() - 0.5) * 5;
    const startY = 34 + Math.random() * 66;
    const driftX = (Math.random() - 0.5) * 8;
    const driftY = -(24 + Math.random() * 44);
    const lifetime = 280 + Math.floor(Math.random() * 220);
    return {
      id: nextSparkId++,
      style: {
        "--trail-particle-x": `${startX}px`,
        "--trail-particle-y": `${startY}%`,
        "--trail-particle-dx": `${driftX}px`,
        "--trail-particle-dy": `${driftY}px`,
        "--trail-particle-size": `${size}px`,
        "--trail-particle-duration": `${lifetime}ms`,
      },
    };
  });
  splashTrailParticles.value.push(...newParticles);
  triggerRef(splashTrailParticles);
  scheduleTimeout(() => {
    if (token !== splashSequenceToken) return;
    const expiredIds = new Set(newParticles.map((p) => p.id));
    splashTrailParticles.value = splashTrailParticles.value.filter((p) => !expiredIds.has(p.id));
  }, 520);
}

function runTrailFire(token: number) {
  if (token !== splashSequenceToken || !splashTrailVisible.value) return;
  emitTrailFireBurst(token);
  scheduleTimeout(() => runTrailFire(token), 70 + Math.floor(Math.random() * 70));
}

function emitPortalBurst(token: number) {
  if (token !== splashSequenceToken) return;
  const newParticles = Array.from({ length: 26 }, () => {
    const direction = Math.random() > 0.5 ? -1 : 1;
    const deltaX = (Math.random() - 0.5) * 18;
    const deltaY = direction * (28 + Math.random() * 86);
    const size = 6 + Math.floor(Math.random() * 6);
    const duration = 180 + Math.floor(Math.random() * 180);
    const startX = (Math.random() - 0.5) * 28;
    const startY = -60 + (Math.random() - 0.5) * 10;
    return {
      id: nextSparkId++,
      style: {
        "--portal-particle-x": `${startX}px`,
        "--portal-particle-y": `${startY}px`,
        "--portal-particle-dx": `${deltaX}px`,
        "--portal-particle-dy": `${deltaY}px`,
        "--portal-particle-size": `${size}px`,
        "--portal-particle-duration": `${duration}ms`,
      },
    };
  });
  splashPortalParticles.value.push(...newParticles);
  triggerRef(splashPortalParticles);
  scheduleTimeout(() => {
    if (token !== splashSequenceToken) return;
    const expiredIds = new Set(newParticles.map((p) => p.id));
    splashPortalParticles.value = splashPortalParticles.value.filter((p) => !expiredIds.has(p.id));
  }, 420);
}

function getSplashSpeed(elapsedMs: number) {
  if (elapsedMs >= FORTY_TO_EIGHTY_EIGHT_MS) return 88;
  if (elapsedMs <= FORTY_TO_SIXTY_MS)
    return INITIAL_SPEED_MPH + (elapsedMs / FORTY_TO_SIXTY_MS) * (60 - INITIAL_SPEED_MPH);
  const extraElapsed = elapsedMs - FORTY_TO_SIXTY_MS;
  const extraDuration = ZERO_TO_EIGHTY_EIGHT_MS - ZERO_TO_SIXTY_MS;
  return 60 + (extraElapsed / extraDuration) * 28;
}

function runSpeedometer(token: number, startTime: number) {
  if (token !== splashSequenceToken || splashTimeMachineLaunching.value) return;
  const now = performance.now();
  const elapsedMs = now - startTime;
  const rawSpeed = Math.min(88, getSplashSpeed(elapsedMs));
  const newSpeed = Math.round(rawSpeed);
  if (newSpeed !== splashSpeedValue.value) splashSpeedValue.value = newSpeed;
  if (splashSpeedValue.value >= SPARK_START_MPH && !splashSparkFlickerStarted) {
    splashSparkFlickerStarted = true;
    runSparkFlicker(token);
  }
  splashPreJumpBarVisible.value =
    splashSpeedValue.value >= PRE_JUMP_BAR_START_MPH && !splashTimeMachineLaunching.value;
  if (splashSpeedValue.value >= 88) {
    splashSpeedValue.value = 88;
    requestAnimationFrame(() => launchSplashDeLorean(token));
    return;
  }
  speedometerFrameId = window.requestAnimationFrame(() => runSpeedometer(token, startTime));
}

// --- Quote phase (CSS-driven, no per-frame JS) ---
const QUOTE =
  "\u201CIf you put your mind to it, you can accomplish anything.\u201D";

function startQuotePhase() {
  phase.value = "quote";
  // CSS animation handles fade-in, hold, fade-out (see .quote-text-anim)
  // Total: 800ms in + 4500ms hold + 800ms out = 6100ms, then fade overlay
  scheduleTimeout(() => startFadeout(), 6100);
}

function startFadeout() {
  const el = overlayRef.value;
  if (!el) {
    emit("done");
    return;
  }
  el.addEventListener("transitionend", () => emit("done"), { once: true });
  el.style.opacity = "0";
}

function handleEscape(e: KeyboardEvent) {
  if (e.key === "Escape") emit("done");
}

onMounted(() => {
  window.addEventListener("keydown", handleEscape);
  // Trigger fade-in via transition (start at opacity:0 in CSS)
  requestAnimationFrame(() => {
    if (overlayRef.value) overlayRef.value.style.opacity = "1";
  });
  const token = ++splashSequenceToken;
  scheduleTimeout(() => runSplashSequence(token), 300);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleEscape);
  splashSequenceToken++;
  clearScheduledTimeouts();
  clearSpeedometerFrame();
});
</script>

<template>
  <div ref="overlayRef" class="bttf-overlay" @click="emit('done')">
    <!-- DeLorean animation phase (stays visible during quote for trail fadeout) -->
    <div v-if="phase === 'animation' || phase === 'quote'" class="launchpad">
      <div
        ref="roadContainerRef"
        :class="['road-lines', { visible: splashTimeMachineEntering, stopped: splashTimeMachineLaunching, 'trail-fade': splashTrailVisible }]"
      >
        <div class="road-line road-line-left"></div>
        <div class="road-line road-line-right"></div>
      </div>
      <Transition name="speedo">
        <div v-if="splashSpeedometerVisible" class="start-screen-speedometer">
          <div class="speedo-cell">
            <span>{{ splashSpeedValue }}</span>
          </div>
        </div>
      </Transition>
      <div
        :class="[
          'start-screen-time-machine',
          {
            enter: splashTimeMachineEntering,
            motion: splashTimeMachineEntering && !splashTimeMachineLaunching,
            glow: splashSpriteGlow,
            launch: splashTimeMachineLaunching,
          },
        ]"
      >
        <div class="time-machine-shell"></div>
        <div class="time-machine-glow"></div>
      </div>
      <div
        v-for="spark in splashSparks"
        :key="spark.id"
        class="start-screen-spark"
        :style="spark.style"
      ></div>
      <div v-if="splashTrailVisible" class="start-screen-trail">
        <span
          v-for="particle in splashTrailParticles"
          :key="particle.id"
          class="start-screen-trail-particle"
          :style="particle.style"
        ></span>
      </div>
      <div v-if="splashPreJumpBarVisible" class="start-screen-pre-jump-bar"></div>
      <div v-if="splashJumpFlashVisible" class="start-screen-jump-flash">
        <span class="jump-flash-split jump-flash-split-left"></span>
        <span class="jump-flash-split jump-flash-split-right"></span>
      </div>
      <div
        v-for="particle in splashPortalParticles"
        :key="particle.id"
        class="start-screen-portal-particle"
        :style="particle.style"
      ></div>
      <div v-if="splashJumpFlashVisible" class="start-screen-white-flash"></div>
    </div>

    <!-- Quote phase (overlays on top of launchpad) -->
    <div v-if="phase === 'quote'" class="quote-phase">
      <p ref="quoteRef" class="quote-text quote-text-anim">{{ QUOTE }}</p>
    </div>
  </div>
</template>

<style scoped lang="css">
@font-face {
  font-family: "Digital";
  src: url("../assets/easter-egg/digital-webfont.woff") format("woff");
  font-weight: normal;
  font-style: normal;
  font-display: block;
}

.bttf-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: rgba(13, 16, 22, 0.9);
  cursor: pointer;
  contain: strict;
  /* GPU-composited fade in/out */
  opacity: 0;
  transition: opacity 400ms ease-out;
  will-change: opacity;
}

.quote-phase {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
}

.quote-text {
  max-width: 65%;
  color: rgba(180, 200, 220, 1);
  font: italic 20px monospace;
  text-align: center;
  line-height: 1.7;
  will-change: opacity;
}

/* CSS-driven quote fade: 800ms in, 4500ms hold, 800ms out */
.quote-text-anim {
  animation: quote-fade 6100ms ease forwards;
}

@keyframes quote-fade {
  0% {
    opacity: 0;
  }
  13.1% {
    opacity: 1;
  } /* 800/6100 */
  86.9% {
    opacity: 1;
  } /* (800+4500)/6100 */
  100% {
    opacity: 0;
  }
}

.launchpad {
  --jump-impact-offset: -60px;
  position: absolute;
  inset: 0;
  overflow: hidden;
  contain: layout style paint;
}

.road-lines {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 800ms ease-out;
  will-change: opacity;
  contain: strict;
  height: 100vh;
  width: 250px;
  border: 4px solid #2a2a2a;
  border-radius: 2px;
  /* sidewalk-left | curb | road | curb | sidewalk-right — all in one gradient */
  background: linear-gradient(
    90deg,
    transparent calc(50% - 130px),
    #30343a calc(50% - 130px),
    #30343a calc(50% - 90px),
    #3e4248 calc(50% - 90px),
    #3e4248 calc(50% - 87px),
    #1e2024 calc(50% - 87px),
    #1e2024 calc(50% + 87px),
    #3e4248 calc(50% + 87px),
    #3e4248 calc(50% + 90px),
    #30343a calc(50% + 90px),
    #30343a calc(50% + 130px),
    transparent calc(50% + 130px)
  );
}

.road-lines.visible {
  opacity: 1;
}

.road-lines.stopped {
  --road-play-state: paused;
}

.road-lines.trail-fade {
  animation: splash-fade-out 2000ms 2000ms forwards;
}

.road-line {
  position: absolute;
  top: -56px;
  width: 4px;
  height: calc(100% + 56px);
  background: repeating-linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.22) 0px,
    rgba(255, 255, 255, 0.22) 24px,
    transparent 24px,
    transparent 56px
  );
  image-rendering: pixelated;
  will-change: transform;
  backface-visibility: hidden;
  contain: layout paint;
  animation: road-scroll 100ms linear infinite;
  animation-play-state: var(--road-play-state, running);
}

.road-line-left {
  left: calc(50% - 72px);
}

.road-line-right {
  left: calc(50% + 70px);
}

.start-screen-speedometer {
  position: absolute;
  left: calc(50% + 150px);
  top: 50%;
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 3px;
  overflow: hidden;
  color: #ff2020;
  text-shadow:
    0 0 8px rgba(255, 32, 32, 0.7),
    0 0 20px rgba(255, 32, 32, 0.4);
  background: #2a2a2a;
  border: 2px solid #888;
  border-radius: 4px;
  box-shadow:
    inset 0 0 0 1px #1a1a1a,
    0 0 18px rgba(0, 0, 0, 0.5);
  font-family: "Digital", monospace;
  transform: translateY(-50%);
}

.speedo-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 10px;
  background: #0a0a0a;
  border-radius: 2px;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8);
}

.speedo-cell span {
  font-size: 42px;
  line-height: 1;
  min-width: 2ch;
  text-align: right;
}

.start-screen-time-machine {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 70px;
  height: 120px;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 800ms ease-out;
  will-change: transform, opacity;
}

.start-screen-time-machine.enter {
  opacity: 1;
}

.start-screen-time-machine.launch {
  opacity: 0;
  transform: translate(-50%, -100vh);
  transition:
    transform 240ms linear,
    opacity 100ms ease-out;
}

.start-screen-time-machine .time-machine-shell {
  position: absolute;
  z-index: 2;
  inset: 0;
  background: center / contain no-repeat url("../assets/easter-egg/time-machine.png");
  filter: drop-shadow(0 0 16px rgba(0, 0, 0, 0.85));
  image-rendering: pixelated;
  will-change: transform;
  backface-visibility: hidden;
}

.start-screen-time-machine .time-machine-glow {
  position: absolute;
  z-index: 3;
  inset: 0;
  background: center / contain no-repeat url("../assets/easter-egg/time-machine.png");
  /* glow via box-shadow on parent instead of filter for perf */
  image-rendering: pixelated;
  opacity: 0;
  will-change: opacity;
  backface-visibility: hidden;
}

.start-screen-time-machine.glow .time-machine-glow {
  opacity: 0.85;
  mix-blend-mode: screen;
}

.start-screen-time-machine.motion .time-machine-shell,
.start-screen-time-machine.motion .time-machine-glow {
  animation: splash-cruise-drift 420ms ease-in-out infinite;
}

.start-screen-time-machine.launch .time-machine-shell,
.start-screen-time-machine.launch .time-machine-glow {
  opacity: 0;
}

.start-screen-spark {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 3;
  width: var(--spark-size);
  height: var(--spark-size);
  background: #c6f6ff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.9);
  image-rendering: pixelated;
  pointer-events: none;
  will-change: transform, opacity;
  backface-visibility: hidden;
  animation: splash-spark-fly 420ms ease-out forwards;
}

.start-screen-trail {
  --trail-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 300' preserveAspectRatio='none'%3E%3Cpath fill='white' d='M7 0C5.8 12 6.4 23 8.2 34c1.7 11 1.2 24-1.3 35-2.3 12-1.8 24 .9 35 2.4 11 2.5 21 .9 32-1.8 12-1.2 24 1.3 36 2.4 12 2.4 24 0 36-2.3 11-2.4 24 0 36 2.4 12 3 23 .9 34-2.1 12-2.3 24 .1 36 2.4 12 2 24-.8 36l10.6 0c-2.8-12-3.2-24-.8-36 2.4-12 2.2-24 .1-36-2.1-11-1.5-22 .9-34 2.4-12 2.3-24 0-36-2.4-12-2.3-24 0-36 2.5-11 3.1-23 1.3-35-1.6-11-1.5-22 .9-33 2.7-12 3.2-24 1.3-35-2.5-11-3-22-1.3-33C17.6 23 18.2 12 17 0L7 0Z'/%3E%3C/svg%3E");
  position: absolute;
  z-index: 0;
  left: 50%;
  bottom: calc(50% - var(--jump-impact-offset));
  width: 68px;
  height: calc(50% + var(--jump-impact-offset));
  overflow: visible;
  opacity: 0;
  transform: translateX(-50%);
  will-change: opacity;
  animation:
    splash-fade-in 30ms linear forwards,
    splash-fade-out 2000ms 2000ms forwards;
}

.start-screen-trail::before,
.start-screen-trail::after {
  content: "";
  position: absolute;
  top: 0;
  width: 13px;
  height: 100%;
  clip-path: inset(100% 0 0 0);
  border-radius: 7px;
  opacity: 0.92;
  background:
    radial-gradient(
      circle at 50% 100%,
      rgba(255, 246, 208, 0.94) 0 7%,
      rgba(255, 216, 118, 0.78) 9%,
      rgba(255, 176, 66, 0.56) 17%,
      rgba(255, 124, 28, 0.3) 26%,
      rgba(255, 124, 28, 0.08) 38%,
      transparent 52%
    ),
    linear-gradient(
      180deg,
      rgba(255, 214, 110, 0) 0%,
      rgba(255, 204, 94, 0.08) 12%,
      rgba(255, 178, 56, 0.16) 26%,
      rgba(255, 144, 38, 0.14) 40%,
      rgba(255, 126, 30, 0.08) 54%,
      rgba(255, 146, 38, 0.12) 68%,
      rgba(255, 98, 24, 0.04) 100%
    ),
    linear-gradient(
      180deg,
      rgba(255, 238, 170, 0.5) 0%,
      rgba(255, 224, 146, 0.54) 9%,
      rgba(255, 198, 92, 0.56) 18%,
      rgba(248, 156, 52, 0.54) 30%,
      rgba(232, 112, 34, 0.5) 42%,
      rgba(206, 80, 24, 0.44) 54%,
      rgba(174, 54, 17, 0.38) 66%,
      rgba(132, 36, 12, 0.3) 78%,
      rgba(96, 24, 9, 0.22) 90%,
      rgba(30, 8, 3, 0.14) 100%
    );
  -webkit-mask-image: var(--trail-mask);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-image: var(--trail-mask);
  mask-repeat: no-repeat;
  mask-size: 100% 100%;
  transform-origin: 50% 0;
  will-change: clip-path, opacity;
  backface-visibility: hidden;
  animation:
    trail-line-grow 500ms cubic-bezier(0.2, 0.85, 0.2, 1) forwards,
    fire-track-flicker 180ms steps(2) 500ms infinite alternate;
}

.start-screen-trail::before {
  left: 0;
}
.start-screen-trail::after {
  right: 0;
  animation:
    trail-line-grow 500ms cubic-bezier(0.2, 0.85, 0.2, 1) forwards,
    fire-track-flicker 220ms steps(2) 500ms infinite alternate;
}

.start-screen-trail-particle {
  position: absolute;
  left: var(--trail-particle-x);
  top: var(--trail-particle-y);
  z-index: 1;
  width: var(--trail-particle-size);
  height: calc(var(--trail-particle-size) * 1.5);
  background: linear-gradient(180deg, #fff8df 0%, #ffb03e 33%, #ff5a1e 66%, #8b1a06 100%);
  image-rendering: pixelated;
  pointer-events: none;
  transform: translateY(0) scale(0.7);
  will-change: transform, opacity;
  backface-visibility: hidden;
  animation: trail-particle-burn var(--trail-particle-duration) ease-out forwards;
}

.start-screen-pre-jump-bar {
  position: absolute;
  z-index: 4;
  left: 50%;
  top: 50%;
  width: 90px;
  height: 8px;
  background: linear-gradient(
    90deg,
    transparent 0,
    rgba(70, 160, 255, 0.3) 8%,
    rgba(110, 200, 255, 0.6) 20%,
    rgba(180, 235, 255, 0.85) 35%,
    #d6f7ff 50%,
    rgba(180, 235, 255, 0.85) 65%,
    rgba(110, 200, 255, 0.6) 80%,
    rgba(70, 160, 255, 0.3) 92%,
    transparent 100%
  );
  box-shadow:
    inset 0 -2px 0 rgba(60, 140, 220, 0.5),
    inset 0 2px 0 rgba(255, 255, 255, 0.4);
  image-rendering: pixelated;
  transform: translate(-50%, calc(-50% - 68px));
  pointer-events: none;
  mix-blend-mode: screen;
  will-change: opacity, transform;
  backface-visibility: hidden;
  animation: pre-jump-bar-flicker 120ms steps(2) infinite alternate;
}

.start-screen-jump-flash {
  position: absolute;
  z-index: 4;
  left: 50%;
  top: 50%;
  width: 70%;
  max-width: 200px;
  height: 20px;
  overflow: visible;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0,
    rgba(205, 245, 255, 0.78) 16%,
    rgba(255, 255, 255, 1) 50%,
    rgba(205, 245, 255, 0.78) 84%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(0.08, 0.05);
  pointer-events: none;
  mix-blend-mode: screen;
  will-change: transform, opacity;
  backface-visibility: hidden;
  animation: jump-flash-core 250ms cubic-bezier(0.2, 0.8, 0.25, 1) forwards;
}

.jump-flash-split {
  position: absolute;
  top: 50%;
  width: 50%;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0,
    rgba(214, 247, 255, 0.78) 28%,
    rgba(255, 255, 255, 0.95) 56%,
    rgba(165, 225, 255, 0.48) 86%,
    rgba(255, 255, 255, 0) 100%
  );
  opacity: 0;
  mix-blend-mode: screen;
  will-change: opacity, transform;
  backface-visibility: hidden;
}

.jump-flash-split-left {
  left: 0;
  transform: translateY(-50%);
  transform-origin: 100% 50%;
  animation: jump-flash-split-left 460ms ease-out forwards;
}

.jump-flash-split-right {
  right: 0;
  transform: translateY(-50%);
  transform-origin: 0 50%;
  animation: jump-flash-split-right 460ms ease-out forwards;
}

.start-screen-white-flash {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: #fff;
  pointer-events: none;
  mix-blend-mode: screen;
  will-change: opacity;
  animation: screen-white-flash 220ms ease-out forwards;
}

.start-screen-jump-flash::before,
.start-screen-jump-flash::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  border-radius: 999px;
  transform: translate(-50%, -50%);
  will-change: opacity, transform;
  backface-visibility: hidden;
}

.start-screen-jump-flash::before {
  width: 16px;
  height: 16px;
  background: radial-gradient(
    circle,
    rgba(255, 255, 255, 1) 0 32%,
    rgba(210, 248, 255, 0.96) 52%,
    rgba(90, 180, 255, 0.3) 74%,
    transparent 100%
  );
  box-shadow:
    0 0 24px rgba(225, 248, 255, 0.92),
    0 0 46px rgba(88, 161, 255, 0.72);
  animation: jump-flash-implosion 460ms ease-out forwards;
}

.start-screen-jump-flash::after {
  width: 20px;
  height: 20px;
  border: 3px solid rgba(220, 247, 255, 0.88);
  box-shadow:
    0 0 22px rgba(220, 247, 255, 0.85),
    0 0 44px rgba(108, 178, 255, 0.6);
  animation: jump-flash-shockwave 460ms ease-out forwards;
}

.start-screen-portal-particle {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 4;
  width: var(--portal-particle-size);
  height: var(--portal-particle-size);
  background: #d6f7ff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.85);
  image-rendering: pixelated;
  pointer-events: none;
  will-change: transform, opacity;
  backface-visibility: hidden;
  animation: portal-particle-burst var(--portal-particle-duration) ease-out forwards;
}

/* Keyframes */
@keyframes road-scroll {
  0% {
    transform: translateY(0);
  }
  100% {
    transform: translateY(56px);
  }
}

@keyframes splash-fade-out {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@keyframes splash-fade-in {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

@keyframes splash-spark-fly {
  0% {
    opacity: 1;
    transform: translate3d(calc(-50% + var(--spark-start-x)), calc(-50% + var(--spark-start-y)), 0)
      scale(1);
  }
  100% {
    opacity: 0;
    transform: translate3d(
        calc(-50% + var(--spark-start-x) + var(--spark-dx)),
        calc(-50% + var(--spark-start-y) + var(--spark-dy)),
        0
      )
      scale(0.35);
  }
}

@keyframes portal-particle-burst {
  0% {
    opacity: 0;
    transform: translate3d(
        calc(-50% + var(--portal-particle-x)),
        calc(-50% + var(--portal-particle-y)),
        0
      )
      scale(0.4);
  }
  18% {
    opacity: 1;
    transform: translate3d(
        calc(-50% + var(--portal-particle-x) + (var(--portal-particle-dx) * 0.18)),
        calc(-50% + var(--portal-particle-y) + (var(--portal-particle-dy) * 0.18)),
        0
      )
      scale(1);
  }
  100% {
    opacity: 0;
    transform: translate3d(
        calc(-50% + var(--portal-particle-x) + var(--portal-particle-dx)),
        calc(-50% + var(--portal-particle-y) + var(--portal-particle-dy)),
        0
      )
      scale(0.25);
  }
}

@keyframes splash-cruise-drift {
  0% {
    transform: translate3d(0, 0, 0) rotate(0deg);
  }
  25% {
    transform: translate3d(-0.3px, -0.5px, 0) rotate(-0.08deg);
  }
  50% {
    transform: translate3d(0.15px, 0.3px, 0) rotate(0.04deg);
  }
  75% {
    transform: translate3d(0.3px, -0.4px, 0) rotate(0.08deg);
  }
  100% {
    transform: translate3d(0, 0, 0) rotate(0deg);
  }
}

@keyframes jump-flash-core {
  0% {
    opacity: 0;
    transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(0.19, 0.04);
  }
  18% {
    opacity: 0.95;
    transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(0.19, 0.035);
  }
  34% {
    opacity: 1;
    transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(1.04, 0.18);
  }
  52% {
    opacity: 0.9;
    transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(1.2, 0.22);
  }
  74% {
    opacity: 0.9;
    transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(1.2, 0.22);
  }
  84% {
    opacity: 0.38;
    transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(0.22, 0.09);
  }
  94% {
    opacity: 0.14;
    transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(0.12, 0.06);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, calc(-50% + var(--jump-impact-offset))) scale(0.095, 0.05);
  }
}

@keyframes jump-flash-implosion {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(2.1);
  }
  20% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(0.12);
  }
  68% {
    opacity: 0.45;
    transform: translate(-50%, -50%) scale(0.68);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.9);
  }
}

@keyframes jump-flash-shockwave {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.08);
  }
  28% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.08);
  }
  46% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.8, 0.45);
  }
  78% {
    opacity: 0.42;
    transform: translate(-50%, -50%) scale(3.6, 0.62);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(5.2, 0.8);
  }
}

@keyframes jump-flash-split-left {
  0%,
  56% {
    opacity: 0;
    transform: translateY(-50%) translateX(0) scaleX(0.19);
  }
  64% {
    opacity: 0.88;
    transform: translateY(-50%) translateX(-48px) scaleX(1.04);
  }
  84% {
    opacity: 0.88;
    transform: translateY(-50%) translateX(-48px) scaleX(1.04);
  }
  92% {
    opacity: 0.18;
    transform: translateY(-50%) translateX(-6px) scaleX(0.22);
  }
  96% {
    opacity: 0.12;
    transform: translateY(-50%) translateX(-1px) scaleX(0.14);
  }
  100% {
    opacity: 0;
    transform: translateY(-50%) translateX(0) scaleX(0.095);
  }
}

@keyframes jump-flash-split-right {
  0%,
  56% {
    opacity: 0;
    transform: translateY(-50%) translateX(0) scaleX(0.19);
  }
  64% {
    opacity: 0.88;
    transform: translateY(-50%) translateX(48px) scaleX(1.04);
  }
  84% {
    opacity: 0.88;
    transform: translateY(-50%) translateX(48px) scaleX(1.04);
  }
  92% {
    opacity: 0.18;
    transform: translateY(-50%) translateX(6px) scaleX(0.22);
  }
  96% {
    opacity: 0.12;
    transform: translateY(-50%) translateX(1px) scaleX(0.14);
  }
  100% {
    opacity: 0;
    transform: translateY(-50%) translateX(0) scaleX(0.095);
  }
}

@keyframes fire-track-flicker {
  0% {
    opacity: 0.88;
  }
  100% {
    opacity: 1;
  }
}

@keyframes pre-jump-bar-flicker {
  0% {
    opacity: 0.76;
    transform: translate(-50%, calc(-50% - 68px)) scaleX(0.96);
  }
  100% {
    opacity: 1;
    transform: translate(-50%, calc(-50% - 68px)) scaleX(1.04);
  }
}

@keyframes trail-line-grow {
  0% {
    clip-path: inset(100% 0 0 0);
  }
  100% {
    clip-path: inset(0 0 0 0);
  }
}

@keyframes trail-particle-burn {
  0% {
    opacity: 0;
    transform: translate3d(0, 4px, 0) scale(0.5);
  }
  20% {
    opacity: 0.95;
    transform: translate3d(calc(var(--trail-particle-dx) * 0.15), -2px, 0) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate3d(var(--trail-particle-dx), var(--trail-particle-dy), 0) scale(0.35);
  }
}

@keyframes screen-white-flash {
  0% {
    opacity: 0;
  }
  8% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

.speedo-enter-active {
  transition:
    opacity 400ms ease-out,
    transform 400ms ease-out;
}
.speedo-leave-active {
  transition:
    opacity 300ms ease-in,
    transform 300ms ease-in;
}
.speedo-enter-from {
  opacity: 0;
  transform: translateY(-50%) scale(0.9);
}
.speedo-leave-to {
  opacity: 0;
  transform: translateY(-50%) scale(0.9);
}
</style>
