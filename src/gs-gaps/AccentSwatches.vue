<script setup lang="ts">
// The eight accent presets as a row of round swatches, the chosen one ringed. While the rainbow owns the colours
// the row stays and is dimmed, since its value still colours what takes no hue.
import { ACCENTS } from '@glimstone/core';

const props = defineProps<{ modelValue: string; disabled?: boolean; name: (n: number) => string }>();
const emit = defineEmits<{ 'update:modelValue': [hex: string] }>();
const chosen = (hex: string) => hex.toLowerCase() === props.modelValue.toLowerCase();
</script>

<template>
  <div class="gs-swatches" role="radiogroup">
    <button v-for="(a, i) in ACCENTS" :key="a.hex" type="button" role="radio" class="gs-swatch" :style="{ '--c': a.hex }" :aria-checked="chosen(a.hex)"
      :aria-label="name(i + 1)" :data-tip="name(i + 1)" :disabled="disabled" @click="emit('update:modelValue', a.hex)"></button>
  </div>
</template>

<style scoped>
.gs-swatches { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; justify-content: flex-end; }
.gs-swatch { width: 1.75rem; height: 1.75rem; flex: none; border-radius: var(--radius-pill); background: var(--c); box-shadow: 0 0 0 2px var(--carbon-surface), 0 0 0 3px transparent; transition: transform var(--motion-control-dur, .12s), box-shadow var(--motion-control-dur, .12s); }
.gs-swatch:hover:not(:disabled) { transform: scale(1.1); }
.gs-swatch[aria-checked="true"] { box-shadow: 0 0 0 2px var(--carbon-surface), 0 0 0 4px var(--carbon-text); }
.gs-swatch:disabled { cursor: default; opacity: .45; }
.gs-swatch:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 4px; }
</style>
