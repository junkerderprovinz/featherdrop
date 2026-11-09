<script setup lang="ts">
// One giving route in a window of its own: the appeal every giving window opens with, the sentence about how this
// route pays, and the way on to the route's own page.
import { Window, type WindowAction } from '@glimstone/vue';
import { computed } from 'vue';

const props = defineProps<{ title: string; appeal: string; text: string; go: string; url: string; glyphKey: string; words: { cancel: string; close: string } }>();
const emit = defineEmits<{ close: [] }>();
const actions = computed<WindowAction[]>(() => [{ label: props.go, labelKey: props.glyphKey, primary: true, onClick: () => { window.open(props.url, '_blank', 'noopener'); } }]);
</script>

<template>
  <Window :title="title" :actions="actions" :text="words" @close="emit('close')">
    <p class="gs-give-appeal">{{ appeal }}</p>
    <p class="gs-give-text">{{ text }}</p>
  </Window>
</template>

<style scoped>
.gs-give-appeal, .gs-give-text { margin: 0; line-height: 1.55; }
.gs-give-text { margin-top: .9rem; color: var(--carbon-text-sub); }
</style>
