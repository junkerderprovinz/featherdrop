<script setup lang="ts">
// The start page and the way of a parcel from there: the files and their
// options, a note or a file request, then the upload and the link, all under
// the castle of the one page. With UPLOAD_PASSWORD set the gate comes first.
// Files arrive here only while the start or the file options show, and text
// pasted on the start page becomes the draft of a note.
import { computed, onBeforeUnmount, onMounted, watch, watchEffect } from 'vue';
import { pastedText, sharedFiles, takeFiles } from '@/src/intake';
import { go, route } from '@/src/router';
import Gate from '@/src/screens/Gate.vue';
import Home, { type Panel } from '@/src/screens/Home.vue';
import { followStage, onHistory } from '@/src/steps';
import { toTop } from '@/src/ui';
import { addFiles, loadPending, resetSend, resumeWith, send, uploadLocked } from '@/src/upload';

const panel = computed<Panel>(() => {
  const at = route.parts[0];
  if (at === 'note' || at === 'request') return at;
  if (send.stage === 'uploading') return 'upload';
  if (send.stage === 'done' && send.sent) return 'link';
  return send.stage === 'options' ? 'files' : null;
});
const open = computed(() => !uploadLocked() && (send.stage === 'home' || send.stage === 'options') && (panel.value === null || panel.value === 'files'));

function take(files: File[]) {
  if (send.stage === 'home' && send.resuming) resumeWith(send.resuming, files);
  else addFiles(files);
}

function writeNote(text: string) {
  pastedText.value = text;
  go('/note');
}

watchEffect((onCleanup) => {
  if (open.value) onCleanup(takeFiles(take, send.stage === 'home' ? writeNote : undefined));
});

// The options under the castle run past the fold, and the castle should be in sight while it shows the upload.
watch(() => send.stage, (stage) => {
  if (stage === 'uploading' || stage === 'done') toTop();
  followStage(stage);
});

onMounted(async () => {
  if (send.stage === 'done') resetSend();
  followStage(send.stage);
  addEventListener('popstate', onHistory);
  await loadPending();
  const shared = await sharedFiles();
  if (shared.length && open.value) addFiles(shared);
});
onBeforeUnmount(() => removeEventListener('popstate', onHistory));
</script>

<template>
  <Gate v-if="uploadLocked()" />
  <Home v-else :panel="panel" />
</template>
