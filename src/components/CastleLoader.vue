<script setup lang="ts">
// The castle that stands for the app. While a transfer runs, the logo turns into the animation in place: letters
// fly into its gate on upload and out of it on download, and the gate flares as each one passes. The page
// around it shows the progress in a bar.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { castleReach, castleStage, logoHeight, setCastle, stillCastle, type CastleInput, type CastleMode } from '@/lib/castle-loader';
import logo from '@/src/assets/castleparcel-logo.svg';
import { playCastle } from '@/src/castle-rive';
import { prefs } from '@/src/prefs';
import { contentTime } from '@/src/ui';

const props = defineProps<{ mode: CastleMode; progress: number | null; size: number }>();

const box = computed(() => ({ width: `${props.size}px`, height: `${logoHeight(props.size)}px` }));
const stageBox = computed(() => {
  const s = castleStage(props.size);
  return { left: `${s.left}px`, top: `${s.top}px`, width: `${s.width}px`, height: `${s.height}px` };
});

// The transfer the stage plays. It plays on while the stage fades back into the logo.
const playing = ref<CastleMode>('idle');
// Whether the stage shows in place of the logo, which only happens once it has drawn a frame.
const live = ref(false);
let drawn = false;
let leaving: ReturnType<typeof setTimeout> | undefined;

watch(() => props.mode, (mode) => {
  clearTimeout(leaving);
  if (mode !== 'idle') {
    playing.value = mode;
    live.value = drawn;
    return;
  }
  live.value = false;
  leaving = setTimeout(() => (playing.value = 'idle'), contentTime());
}, { immediate: true });
onBeforeUnmount(() => clearTimeout(leaving));

const stage = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const reduced = ref(false);
const reach = ref(0);
let inputs: CastleInput[] = [];
const apply = () =>
  setCastle(inputs, { mode: playing.value, progress: props.progress, still: stillCastle(prefs.motion, reduced.value), reach: reach.value });
watch(() => [playing.value, props.progress, prefs.motion, reduced.value, reach.value], apply);

watch(canvas, (el, _, onCleanup) => {
  if (!el || !stage.value) return;
  const query = matchMedia('(prefers-reduced-motion: reduce)');
  const follow = () => (reduced.value = query.matches);
  follow();
  query.addEventListener('change', follow);
  const stop = playCastle(el, stage.value, {
    ready: (list) => {
      inputs = list;
      apply();
      requestAnimationFrame(() => {
        drawn = true;
        live.value = props.mode !== 'idle';
      });
    },
    placed: (edge, width) => (reach.value = castleReach(edge, width)),
  });
  onCleanup(() => {
    query.removeEventListener('change', follow);
    stop();
    inputs = [];
    drawn = false;
  });
});
</script>

<template>
  <div class="castle" :class="{ live }" :data-mode="playing" :style="box">
    <img class="castle-logo" :src="logo" :width="size" :height="Math.round(logoHeight(size))" alt="">
    <div v-if="playing !== 'idle'" ref="stage" class="castle-stage" :style="stageBox">
      <canvas ref="canvas" class="castle-canvas" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.castle { position: relative; flex: none; }
.castle-logo { display: block; width: 100%; height: 100%; }
/* castleStage puts the stage where its tower covers the logo's. The canvas spans the window from edge to edge at
   the stage's height, so the letters come from and fly past the window's edges; castle-rive places it there. */
.castle-stage { position: absolute; opacity: 0; pointer-events: none; }
.castle-canvas { position: absolute; top: 0; left: 0; display: block; width: 100%; height: 100%; }
.castle.live .castle-logo { opacity: 0; }
.castle.live .castle-stage { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .castle-logo, .castle-stage { transition: opacity var(--motion-content-dur, .22s) ease; }
}
</style>
