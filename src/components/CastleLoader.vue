<script setup lang="ts">
// The castle that stands for the app. While a transfer runs, letters fly into its gate on upload and
// out of it on download, and the gate glows with the progress. The bar below carries the same number
// for assistive technology.
import { computed, ref, watch } from 'vue';
import { setCastle, stillCastle, type CastleInput, type CastleMode } from '@/lib/castle-loader';
import logo from '@/src/assets/castleparcel-logo.svg';
import { playCastle } from '@/src/castle-rive';
import { prefs } from '@/src/prefs';

const props = defineProps<{ mode: CastleMode; progress: number | null; size: number }>();
const busy = computed(() => props.mode !== 'idle');
const fill = computed(() => Math.min(1, Math.max(0, props.progress ?? 0)));

const canvas = ref<HTMLCanvasElement | null>(null);
const reduced = ref(false);
let inputs: CastleInput[] = [];
const apply = () => setCastle(inputs, { mode: props.mode, progress: props.progress, still: stillCastle(prefs.motion, reduced.value) });
watch(() => [props.mode, props.progress, prefs.motion, reduced.value], apply);

watch(canvas, (el, _, onCleanup) => {
  if (!el) return;
  const query = matchMedia('(prefers-reduced-motion: reduce)');
  const follow = () => (reduced.value = query.matches);
  follow();
  query.addEventListener('change', follow);
  const stop = playCastle(el, (list) => {
    inputs = list;
    apply();
  });
  onCleanup(() => {
    query.removeEventListener('change', follow);
    stop();
    inputs = [];
  });
});
</script>

<template>
  <div v-if="busy" class="castle" :data-mode="mode">
    <canvas ref="canvas" class="castle-canvas" aria-hidden="true" />
    <div class="castle-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(fill * 100)">
      <span :style="{ width: `${fill * 100}%` }" />
    </div>
  </div>
  <img v-else class="castle-logo" :src="logo" :width="size" :height="Math.round(size * 1.197)" alt="">
</template>

<style scoped>
.castle { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 12px; }
/* The artboard is 1520 by 1110 with the tower in the middle. The letters never leave the band from
   175 to 935, so the canvas covers just that band at 2 to 1. The sides fade out, so a letter coming
   in from beyond the artboard or leaving it never shows a cut edge in the middle of a wide page. */
.castle-canvas { display: block; width: 100%; height: auto; aspect-ratio: 2; mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent); }
.castle-bar { width: min(20rem, 70%); height: 6px; border-radius: 3px; background: var(--carbon-surface3); overflow: hidden; }
.castle-bar span { display: block; height: 100%; background: var(--accent); transition: width var(--motion-control-dur, .15s) linear; }
.castle-logo { display: block; height: auto; }
</style>
