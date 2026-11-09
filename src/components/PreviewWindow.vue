<script setup lang="ts">
// One file of the share over the page, decrypted in this browser. Previews
// render inertly so nothing runs against the page: text as text in a <pre>,
// an SVG only inside an <img>, a PDF in an <embed>. The arrows step through
// the files that have a preview, and the download is the window's forward step.
import { EmptyState, Window, type WindowAction } from '@glimstone/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { size } from '@/src/format';
import { fileGlyph, glyph } from '@/src/glyphs';
import { t } from '@/src/i18n';
import { closePreview, loadPreview, type Entry, type Preview } from '@/src/receive';
import { windowWords } from '@/src/ui';

const props = defineProps<{ item: Entry; many: boolean }>();
const emit = defineEmits<{ close: []; step: [by: number]; download: [item: Entry] }>();

const shown = ref<Preview | null>(null);
const note = ref('');
const loading = ref(true);

async function load() {
  loading.value = true;
  shown.value = null;
  note.value = '';
  const got = await loadPreview(props.item);
  if (typeof got === 'string') note.value = got;
  else shown.value = got;
  loading.value = false;
}
watch(() => props.item.index, load);
onMounted(load);

function onKey(e: KeyboardEvent) {
  if (!props.many) return;
  const rtl = document.documentElement.dir === 'rtl';
  if (e.key === 'ArrowLeft') emit('step', rtl ? 1 : -1);
  else if (e.key === 'ArrowRight') emit('step', rtl ? -1 : 1);
}
onMounted(() => addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  removeEventListener('keydown', onKey);
  closePreview();
});

const actions = computed<WindowAction[]>(() => [
  { label: t('common.close'), labelKey: 'IconClose', wayOut: true },
  ...(props.many ? [
    { label: t('common.previous'), labelKey: 'IconBack', onClick: () => { emit('step', -1); return false as const; } },
    { label: t('common.next'), labelKey: 'IconForward', onClick: () => { emit('step', 1); return false as const; } },
  ] : []),
  { label: t('common.download'), labelKey: 'IconDownload', primary: true, onClick: () => emit('download', props.item) },
]);
</script>

<template>
  <Window :title="item.name" size="wide" :actions="actions" :start="item.size === null ? undefined : size(item.size)" :text="windowWords()" class="cp-preview" @close="emit('close')">
    <div class="cp-preview-body" :class="shown?.kind" data-cp="preview">
      <span v-if="loading" class="cp-spin" aria-hidden="true"></span>
      <pre v-else-if="shown?.kind === 'text'" class="cp-text-preview">{{ shown.text }}</pre>
      <img v-else-if="shown?.kind === 'image'" :src="shown.url" :alt="item.name">
      <video v-else-if="shown?.kind === 'video'" :src="shown.url" controls></video>
      <audio v-else-if="shown?.kind === 'audio'" :src="shown.url" controls></audio>
      <embed v-else-if="shown?.kind === 'pdf'" :src="shown.url" type="application/pdf">
      <EmptyState v-else nested :glyph="glyph(fileGlyph(item.name))" :title="note || t('receive.noPreview')" />
    </div>
  </Window>
</template>
