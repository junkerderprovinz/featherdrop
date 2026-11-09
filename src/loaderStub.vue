<script setup lang="ts">
// Holds the place of the castle animation until one of the drafts is chosen, with the same props, so the screens
// keep their final layout. The bar under the logo carries the progress meanwhile.
import { computed } from 'vue';
import logo from '@/src/assets/castleparcel-logo.svg';

const props = defineProps<{ mode: 'idle' | 'upload' | 'download'; progress: number | null; size: number }>();
const busy = computed(() => props.mode !== 'idle');
const fill = computed(() => (props.progress === null ? 0 : Math.min(1, Math.max(0, props.progress))));
</script>

<template>
  <div class="castle-stub" :data-mode="mode" :style="{ width: `${size}px` }">
    <img :src="logo" :width="size" :height="Math.round(size * 1.197)" alt="">
    <div v-if="busy && size >= 96" class="castle-stub-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(fill * 100)">
      <span :style="{ width: `${fill * 100}%` }" />
    </div>
  </div>
</template>

<style scoped>
.castle-stub { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.castle-stub img { display: block; width: 100%; height: auto; }
.castle-stub-bar { width: 70%; height: 6px; border-radius: 3px; background: var(--carbon-surface3); overflow: hidden; }
.castle-stub-bar span { display: block; height: 100%; background: var(--accent); transition: width var(--motion-control-dur, .15s) linear; }
</style>
