<script setup lang="ts">
// The start page and the way of a parcel from there: the files and their
// options, a note or a file request open under the castle, then the upload and
// the link. With UPLOAD_PASSWORD set the gate comes first. Files arrive here
// only while the start or the file options show, and text pasted on the start
// page becomes the draft of a note.
import { computed, onMounted, watch, watchEffect } from 'vue';
import { pastedText, sharedFiles, takeFiles } from '@/src/intake';
import { go, route } from '@/src/router';
import Done from '@/src/screens/Done.vue';
import Gate from '@/src/screens/Gate.vue';
import Home, { type Panel } from '@/src/screens/Home.vue';
import Uploading from '@/src/screens/Uploading.vue';
import { addFiles, loadPending, resetSend, resumeWith, send, uploadLocked } from '@/src/upload';

const panel = computed<Panel>(() => {
  const at = route.parts[0];
  if (at === 'note' || at === 'request') return at;
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

// The options under the castle run past the fold, and the upload and the link open as pages of their own.
watch(() => send.stage, (stage) => {
  if (stage === 'uploading' || stage === 'done') scrollTo(0, 0);
});

onMounted(async () => {
  if (send.stage === 'done') resetSend();
  await loadPending();
  const shared = await sharedFiles();
  if (shared.length && open.value) addFiles(shared);
});
</script>

<template>
  <Gate v-if="uploadLocked()" />
  <Uploading v-else-if="send.stage === 'uploading'" />
  <Done v-else-if="send.stage === 'done' && send.sent" :sent="send.sent" @more="resetSend" />
  <Home v-else :panel="panel" />
</template>
