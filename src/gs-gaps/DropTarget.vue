<script setup lang="ts">
// The place files go: a large button around a picture that opens the file picker, and lights up while files are
// dragged over the page, wherever they would be let go.
defineProps<{ label: string; armed: boolean; disabled?: boolean }>();
</script>

<template>
  <button type="button" class="gs-drop" :class="{ armed }" :aria-label="label" :disabled="disabled">
    <span class="gs-drop-glow" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<style scoped>
.gs-drop { position: relative; isolation: isolate; display: grid; place-items: center; padding: 1.5rem 2.5rem; border-radius: var(--radius-card); cursor: pointer; transition: transform var(--motion-control-dur, .15s) ease; }
.gs-drop:disabled { cursor: default; }
.gs-drop:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 4px; }
/* Behind the picture and well past its edges, so the picture stands in the light instead of under a haze. It only
   lights where a click or a drop would land, so at rest the picture stands on the plain page. */
.gs-drop-glow { position: absolute; inset: -22% -34%; z-index: -1; border-radius: 50%; background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 40%, transparent), color-mix(in srgb, var(--accent) 14%, transparent) 55%, transparent); opacity: 0; transition: opacity var(--motion-control-dur, .15s) ease; pointer-events: none; }
.gs-drop:not(:disabled):is(:hover, :focus-visible) .gs-drop-glow { opacity: .9; }
.gs-drop.armed .gs-drop-glow { opacity: 1; }
:root:not([data-motion="off"]) .gs-drop.armed { transform: scale(1.04); }
@media (prefers-reduced-motion: reduce) { .gs-drop, .gs-drop-glow { transition: none; } }
</style>
