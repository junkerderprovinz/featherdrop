<script setup lang="ts">
// The start page and the way of a parcel from there: the files and their
// options, the upload, and the link. With UPLOAD_PASSWORD set the gate comes
// first. Files arrive here only while the start or the options show, and
// text pasted on the start page becomes the draft of a note.
import { computed, onMounted, watchEffect } from 'vue';
import { pastedText, sharedFiles, takeFiles } from '@/src/intake';
import { go } from '@/src/router';
import Done from '@/src/screens/Done.vue';
import Gate from '@/src/screens/Gate.vue';
import Home from '@/src/screens/Home.vue';
import Options from '@/src/screens/Options.vue';
import Uploading from '@/src/screens/Uploading.vue';
import { addFiles, loadPending, resetSend, resumeWith, send, uploadLocked } from '@/src/upload';

const open = computed(() => !uploadLocked() && (send.stage === 'home' || send.stage === 'options'));

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

onMounted(async () => {
  if (send.stage === 'done') resetSend();
  await loadPending();
  const shared = await sharedFiles();
  if (shared.length && open.value) addFiles(shared);
});
</script>

<template>
  <Gate v-if="uploadLocked()" />
  <Options v-else-if="send.stage === 'options'" />
  <Uploading v-else-if="send.stage === 'uploading'" />
  <Done v-else-if="send.stage === 'done' && send.sent" :sent="send.sent" @more="resetSend" />
  <Home v-else />
</template>
