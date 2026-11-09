<script setup lang="ts">
// The page behind a collect link: what was sent to a request, saved or read
// here, and the way to close the request. The collect link's secret never
// leaves this browser, only a token derived from it does.
import { Button, Card, CopyField, EmptyState, FieldRow, ListRow } from '@glimstone/vue';
import { reactive, ref } from 'vue';
import { downloadDecryptedV2 } from '@/lib/e2e/download-flow';
import { readNote } from '@/lib/e2e/note';
import {
  closeRequest,
  deleteRequestUpload,
  fetchUploadBlob,
  listRequestUploads,
  parseCollectUrl,
  requestUrl,
  type CollectedUpload,
  type CollectLink,
} from '@/lib/e2e/request-flow';
import { blobDownload, canStreamDownload, streamToDownload } from '@/lib/e2e/stream-download';
import { cryptoWorker } from '@/lib/e2e/v2/crypto-worker';
import NoteView from '@/src/components/NoteView.vue';
import { baseUrl } from '@/src/config';
import { confirm } from '@/src/confirm';
import { dateTime, fileCount, size } from '@/src/format';
import { G, fileGlyph, glyph } from '@/src/glyphs';
import { plural, t } from '@/src/i18n';
import { follow } from '@/src/router';
import { toast } from '@/src/toast';
import { copyWords } from '@/src/ui';

function linkFromLocation(): CollectLink | null {
  try {
    return parseCollectUrl(location.href);
  } catch {
    return null;
  }
}

const collect = linkFromLocation();
const phase = ref<'loading' | 'ready' | 'closed' | 'notfound'>(collect ? 'loading' : 'notfound');
const uploads = ref<CollectedUpload[]>([]);
const shareLink = ref('');
const notes = reactive<Record<string, string>>({});
const busy = ref<string | null>(null);

if (collect) {
  void requestUrl(cryptoWorker, baseUrl(), collect).then((url) => (shareLink.value = url));
  listRequestUploads(cryptoWorker, collect).then(
    (c) => {
      uploads.value = c.uploads;
      phase.value = 'ready';
    },
    () => (phase.value = 'notfound'),
  );
}

async function save(plaintext: ReadableStream<Uint8Array>, name: string, length: number) {
  if (canStreamDownload()) await streamToDownload(plaintext, name, length);
  else blobDownload(await new Response(plaintext).blob(), name);
}

async function open(up: Extract<CollectedUpload, { readable: true }>) {
  busy.value = up.id;
  try {
    const fetchBlob = fetchUploadBlob(cryptoWorker, collect!, up.id);
    if (up.header.kind === 'text') notes[up.id] = await readNote(cryptoWorker, fetchBlob, { keys: up.keys });
    else {
      await downloadDecryptedV2(cryptoWorker, fetchBlob, { keys: up.keys }, save, `${collect!.slug}.zip`);
      toast(plural(up.header.files.length, 'receive.saved'));
    }
  } catch {
    toast(t('receive.failed'), 'fail');
  } finally {
    busy.value = null;
  }
}

async function remove(id: string) {
  busy.value = id;
  try {
    await deleteRequestUpload(cryptoWorker, collect!, id);
    uploads.value = uploads.value.filter((u) => u.id !== id);
    toast(t('collect.deleted'));
  } catch {
    toast(t('collect.deleteFailed'), 'fail');
  } finally {
    busy.value = null;
  }
}

async function close() {
  if (!(await confirm(t('collect.closeQuestion'), { confirmLabel: t('collect.close'), confirmLabelKey: 'IconTrash' }))) return;
  busy.value = 'close';
  try {
    await closeRequest(cryptoWorker, collect!);
    phase.value = 'closed';
  } catch {
    toast(t('collect.deleteFailed'), 'fail');
  } finally {
    busy.value = null;
  }
}

const files = (up: Extract<CollectedUpload, { readable: true }>) => up.header.files;
</script>

<template>
  <section v-if="phase === 'notfound' || phase === 'closed'" class="cp-narrow" data-cp="collect-end">
    <EmptyState
      :glyph="glyph(phase === 'closed' ? 'IconTrash' : 'IconUnlink')"
      :title="t(phase === 'closed' ? 'collect.closedTitle' : 'send.notFoundTitle')"
      :hint="t(phase === 'closed' ? 'collect.closedText' : 'send.notFoundText')"
    >
      <Button :label="t('gone.send')" label-key="IconUpload" href="/" @click="follow($event, '/')" />
    </EmptyState>
  </section>
  <section v-else class="cp-column">
    <Card :title="t('collect.title')">
      <CopyField v-if="shareLink" :value="shareLink" :label="t('collect.requestLink')" width="fill" :text="copyWords()" data-cp="request-link" />
      <EmptyState v-if="phase === 'ready' && !uploads.length" nested :glyph="glyph('IconEmpty')" :title="t('collect.empty')" :hint="t('collect.emptyHint')" />
    </Card>

    <template v-for="up in uploads" :key="up.id">
      <Card v-if="up.readable" :title="up.header.kind === 'text' ? t('collect.note') : fileCount(files(up).length)" :hint="t('collect.sentAt', { when: dateTime(up.createdAt) })" data-cp="upload">
        <NoteView v-if="notes[up.id] !== undefined" :text="notes[up.id]" />
        <div v-else-if="up.header.kind !== 'text'" class="cp-rows" role="list">
          <ListRow v-for="(f, i) in files(up)" :key="i" :name="f.name" role="listitem">
            <template #tile><G :n="fileGlyph(f.name)" /></template>
            <template #badges><span class="cp-size glim-num">{{ size(f.size) }}</span></template>
          </ListRow>
        </div>
        <div v-if="notes[up.id] === undefined" class="cp-actions cp-gap-top">
          <Button v-if="up.header.kind === 'text'" tone="accent" :busy="busy === up.id" :label="t('note.show')" label-key="IconEye" data-cp="show-note" @click="open(up)" />
          <Button v-else tone="accent" :busy="busy === up.id" :label="t('common.download')" label-key="IconDownload" data-cp="download" @click="open(up)" />
        </div>
      </Card>
      <Card v-else :title="t('collect.unreadableTitle')" :hint="t('collect.sentAt', { when: dateTime(up.createdAt) })" data-cp="unreadable">
        <p class="cp-text">{{ t('collect.unreadableText') }}</p>
        <div class="cp-actions cp-gap-top">
          <Button :busy="busy === up.id" :label="t('common.delete')" label-key="IconTrash" data-cp="delete-upload" @click="remove(up.id)" />
        </div>
      </Card>
    </template>

    <Card :title="t('collect.close')">
      <FieldRow :label="t('collect.close')" :hint="t('collect.closeHint')">
        <Button :busy="busy === 'close'" :label="t('collect.close')" label-key="IconTrash" data-cp="close-request" @click="close" />
      </FieldRow>
    </Card>
  </section>
</template>
