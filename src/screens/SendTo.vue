<script setup lang="ts">
// The page behind a request link: the files picked here are encrypted in this
// browser and sealed to the requester's key, and only the collect link opens them.
import { Button, Card, EmptyState, ListRow, ProgressBar } from '@glimstone/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  fetchRequestInfo,
  parseRequestUrl,
  RequestClosedError,
  RequestNotFoundError,
  RequestTooLargeError,
  sendToRequest,
  type RequestLink,
} from '@/lib/e2e/request-flow';
import { tusUpload } from '@/lib/e2e/tus-upload';
import { cryptoWorker } from '@/lib/e2e/v2/crypto-worker';
import { fileCount, size } from '@/src/format';
import { G, fileGlyph, glyph } from '@/src/glyphs';
import { t } from '@/src/i18n';
import { pickFiles, takeFiles } from '@/src/intake';
import { follow } from '@/src/router';
import { refusal } from '@/src/upload';

function linkFromLocation(): RequestLink | null {
  try {
    return parseRequestUrl(location.href);
  } catch {
    return null;
  }
}

const link = linkFromLocation();
const phase = ref<'loading' | 'ready' | 'sending' | 'sent' | 'closed' | 'notfound'>(link ? 'loading' : 'notfound');
const cap = ref<number | null>(null);
const files = ref<File[]>([]);
const progress = ref(0);
const error = ref('');

if (link) {
  fetchRequestInfo(link).then(
    (info) => {
      cap.value = info.maxSize;
      phase.value = info.open ? 'ready' : 'closed';
    },
    () => (phase.value = 'notfound'),
  );
}

onBeforeUnmount(
  takeFiles((picked) => {
    if (phase.value !== 'ready') return;
    files.value = [...files.value, ...picked];
    error.value = '';
  }),
);

const total = computed(() => files.value.reduce((sum, f) => sum + f.size, 0));

async function send() {
  if (!link || !files.value.length) return;
  phase.value = 'sending';
  error.value = '';
  try {
    await sendToRequest(files.value, link, { upload: tusUpload, crypto: cryptoWorker }, (f) => (progress.value = f));
    phase.value = 'sent';
  } catch (e) {
    if (e instanceof RequestClosedError) return void (phase.value = 'closed');
    if (e instanceof RequestNotFoundError) return void (phase.value = 'notfound');
    phase.value = 'ready';
    if (e instanceof RequestTooLargeError) error.value = t('send.tooLarge', { size: size(e.maxSize) });
    else if (refusal(e)?.status === 429) error.value = t('send.busy');
    else error.value = t('upload.failed');
  }
}

function more() {
  files.value = [];
  progress.value = 0;
  phase.value = 'ready';
}
</script>

<template>
  <section v-if="phase === 'notfound' || phase === 'closed' || phase === 'sent'" class="cp-narrow" data-cp="send-end">
    <EmptyState
      v-if="phase === 'sent'"
      :glyph="glyph('IconCheck')"
      :title="t('send.sentTitle')"
      :hint="t('send.sentText')"
    >
      <Button :label="t('send.more')" label-key="IconAdd" @click="more" />
    </EmptyState>
    <EmptyState
      v-else
      :glyph="glyph(phase === 'closed' ? 'IconEmpty' : 'IconUnlink')"
      :title="t(phase === 'closed' ? 'send.closedTitle' : 'send.notFoundTitle')"
      :hint="t(phase === 'closed' ? 'send.closedText' : 'send.notFoundText')"
    >
      <Button :label="t('gone.send')" label-key="IconUpload" href="/" @click="follow($event, '/')" />
    </EmptyState>
  </section>
  <section v-else class="cp-column">
    <Card :title="t('send.title')" :hint="t('send.intro')">
      <p v-if="cap !== null" class="cp-text" data-cp="cap">{{ t('send.cap', { size: size(cap) }) }}</p>
      <EmptyState v-if="!files.length" nested :glyph="glyph('IconUpload')" :title="t('send.choose')" :hint="t('home.drop')" />
      <div v-else class="cp-rows" role="list">
        <ListRow v-for="(f, i) in files" :key="i" :name="f.name" role="listitem">
          <template #tile><G :n="fileGlyph(f.name)" /></template>
          <template #badges><span class="cp-size glim-num">{{ size(f.size) }}</span></template>
        </ListRow>
      </div>
      <ProgressBar v-if="phase === 'sending'" class="cp-gap-top" :value="progress" :label="t('upload.uploading')" />
      <div class="cp-card-foot">
        <span class="cp-sub glim-num">{{ files.length ? `${fileCount(files.length)}, ${size(total)}` : '' }}</span>
        <Button :label="t('send.choose')" label-key="IconAdd" :disabled="phase === 'sending'" data-cp="choose" @click="pickFiles" />
      </div>
    </Card>
    <p v-if="error" class="cp-error" role="alert">{{ error }}</p>
    <div class="cp-actions">
      <Button size="key" tone="accent" :busy="phase === 'sending'" :disabled="!files.length || phase === 'sending'" :label="t('send.send')" label-key="IconUpload" data-cp="send" @click="send" />
    </div>
  </section>
</template>
