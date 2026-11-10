<script setup lang="ts">
// What the recipient sees under the castle, which stands where it stands on the
// start page: the parcel with a preview of each file, the password when it has
// one, the download, which the castle shows in its gate, a note to read, and a
// kind word when the link leads nowhere any more.
import { Button, Card, EmptyState, FieldRow, ListRow, PasswordField, Pill, ProgressBar } from '@glimstone/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppMark from '@/src/components/AppMark.vue';
import NoteView from '@/src/components/NoteView.vue';
import PreviewWindow from '@/src/components/PreviewWindow.vue';
import { dateTime, fileCount, relative, size } from '@/src/format';
import { G, fileGlyph, glyph } from '@/src/glyphs';
import { num, plural, t } from '@/src/i18n';
import {
  canPick,
  canSaveToFolder,
  downloadAll,
  downloadOne,
  kindOfEntry,
  leaveShare,
  openShare,
  saveToFolder,
  several,
  share,
  unlock,
  type Entry,
  type Gone,
} from '@/src/receive';
import { follow, route } from '@/src/router';
import { toast } from '@/src/toast';
import { eyeWords, shake, toTop } from '@/src/ui';

const GONE_GLYPH: Record<Gone, string> = { expired: 'IconHourglass', burned: 'IconEmpty', missing: 'IconUnlink', nokey: 'IconKeyRevoke' };

void openShare(route.parts[1] ?? '', location.hash);
onBeforeUnmount(leaveShare);

// A single file picked far down the list starts a download the castle shows.
watch(() => share.view, (view) => {
  if (view === 'downloading') toTop();
});

const total = computed(() => (share.items ?? []).reduce((sum, x) => sum + (x.size ?? 0), 0));
const summary = computed(() => {
  if (share.kind === 'text') return t('note.received');
  if (!share.items) return size(share.size);
  return t('receive.summary', { count: fileCount(share.items.length), size: size(total.value || share.size) });
});
const expires = computed(() => (share.expiresAt === null ? t('receive.never') : t('receive.expires', { when: relative(share.expiresAt) })));
const busyItems = computed(() => (share.items ?? []).filter((x) => share.only === null || x.index === share.only));

const shown = ref<Entry | null>(null);
const withPreview = computed(() => (share.items ?? []).filter((x) => kindOfEntry(x)));
function step(by: number) {
  const list = withPreview.value;
  const i = list.findIndex((x) => x.index === shown.value?.index);
  shown.value = list[(i + by + list.length) % list.length] ?? null;
}
const previewTitle = (x: Entry) => (!kindOfEntry(x) ? t('receive.noPreview') : !canPick() ? t('receive.previewLimited') : undefined);

async function all() {
  const n = await downloadAll();
  if (n) toast(plural(n, 'receive.saved'));
}
async function one(x: Entry) {
  shown.value = null;
  if (await downloadOne(x.index)) toast(plural(1, 'receive.saved'));
}
async function folder() {
  const n = await saveToFolder();
  if (n) toast(plural(n, 'receive.saved'));
}

const password = ref('');
const field = ref<InstanceType<typeof PasswordField> | null>(null);
async function submit() {
  if (!password.value) share.error = t('receive.empty');
  else if (await unlock(password.value)) return;
  shake(field.value?.input);
}
</script>

<template>
  <section class="cp-hero cp-hero-open">
    <div class="cp-mark cp-mark-still">
      <AppMark :size="280" :mode="share.view === 'downloading' ? 'download' : 'idle'" :progress="share.progress" />
    </div>

    <div :key="share.view" class="cp-panel glim-content-fade" :data-cp="`view-${share.view}`">
      <section v-if="share.view === 'gone'" class="cp-column" data-cp="gone">
        <EmptyState :glyph="glyph(GONE_GLYPH[share.gone])" :title="t(`gone.${share.gone}Title`)" :hint="t(`gone.${share.gone}Text`)">
          <Button :label="t('gone.send')" label-key="IconUpload" href="/" @click="follow($event, '/')" />
        </EmptyState>
      </section>

      <section v-else-if="share.view === 'loading'" class="cp-column">
        <div class="cp-stage" aria-live="polite">
          <p class="cp-sub">{{ t('receive.opening') }}</p>
        </div>
      </section>

      <section v-else-if="share.view === 'locked'" class="cp-column">
        <Card :title="t('receive.lockedTitle')">
          <form class="cp-form" novalidate @submit.prevent="submit">
            <p class="cp-text">{{ t('receive.lockedText') }}</p>
            <FieldRow :label="t('receive.password')">
              <PasswordField ref="field" v-model="password" width="medium" autocomplete="off" :text="eyeWords()" data-cp="share-password" />
            </FieldRow>
            <p v-if="share.error" class="cp-error" role="alert">{{ share.error }}</p>
            <div class="cp-actions">
              <Button size="key" tone="accent" type="submit" :busy="share.busy" :label="t('receive.unlock')" label-key="IconUnlock" data-cp="unlock" />
            </div>
          </form>
        </Card>
      </section>

      <section v-else-if="share.view === 'note'" class="cp-column">
        <Card :title="t('note.received')" :hint="t('note.receivedHint')">
          <NoteView :text="share.note" />
        </Card>
      </section>

      <section v-else-if="share.view === 'downloading'" class="cp-column">
        <div class="cp-stage">
          <div class="cp-stage-text" aria-live="polite">
            <span class="cp-phase">{{ t('receive.' + share.phase) }}</span>
            <span class="cp-percent glim-num">{{ num(share.progress, { style: 'percent' }) }}</span>
          </div>
          <ProgressBar class="cp-stage-bar" :value="share.progress" :label="t('receive.downloading')" data-cp="progress" />
          <p class="cp-sub"><G n="IconShieldOn" />{{ t('receive.decryptedHere') }}</p>
        </div>
        <Card v-if="busyItems.length" :title="t('receive.files')">
          <div class="cp-rows" role="list">
            <ListRow v-for="x in busyItems" :key="x.index" :name="x.name" role="listitem">
              <template #tile><G :n="fileGlyph(x.name)" /></template>
              <template #badges>
                <Pill v-if="x.size !== null && x.done >= x.size && share.progress > 0" tone="ok">{{ t('upload.fileDone') }}</Pill>
                <span v-else-if="x.done === 0" class="cp-size">{{ t('upload.waiting') }}</span>
                <ProgressBar v-else class="cp-row-bar" :value="x.done / (x.size || 1)" :label="x.name" />
              </template>
            </ListRow>
          </div>
        </Card>
      </section>

      <section v-else class="cp-column">
        <Card :title="t('receive.title')">
          <div class="cp-parcel">
            <div class="cp-parcel-text">
              <span class="cp-parcel-name glim-num" data-cp="summary">{{ summary }}</span>
              <span class="cp-sub glim-num" :data-tip="share.expiresAt === null ? undefined : dateTime(share.expiresAt)">{{ expires }}</span>
            </div>
            <span class="cp-buttons">
              <Button v-if="several() && canSaveToFolder()" size="key" :label="t('receive.saveFolder')" label-key="IconFolderSave" :title="t('receive.saveFolderHint')" @click="folder" />
              <Button v-if="share.kind === 'text'" size="key" tone="accent" :label="t('note.show')" label-key="IconEye" data-cp="show-note" @click="all" />
              <Button v-else size="key" tone="accent" :label="several() ? t('receive.downloadAll') : t('common.download')" label-key="IconDownload" data-cp="download-all" @click="all" />
            </span>
          </div>
          <p v-if="share.error" class="cp-error cp-gap-top" role="alert" data-cp="error">{{ share.error }}</p>
          <div class="cp-card-foot">
            <span class="cp-sub"><G n="IconShieldOn" />{{ t('receive.decryptedHere') }}</span>
            <Pill v-if="share.downloadsLeft !== null" :tone="share.downloadsLeft === 1 ? 'warn' : 'neutral'" :data-tip="share.downloadsLeft === 1 ? t('receive.lastDownload') : undefined">{{ plural(share.downloadsLeft, 'receive.left') }}</Pill>
          </div>
        </Card>

        <Card v-if="share.items && share.kind !== 'text'" :title="t('receive.files')">
          <div class="cp-rows" role="list" data-cp="files">
            <ListRow v-for="x in share.items" :key="x.index" :name="x.name" role="listitem">
              <template #tile><img v-if="share.thumbs[x.index]" class="cp-thumb" :src="share.thumbs[x.index]" alt=""><G v-else :n="fileGlyph(x.name)" /></template>
              <template #badges><span v-if="x.size !== null" class="cp-size glim-num">{{ size(x.size) }}</span></template>
              <template #actions>
                <Button variant="icon" :compact-below="640" :label="t('common.preview')" label-key="IconEye" :disabled="!kindOfEntry(x) || !canPick()" :title="previewTitle(x)" data-cp="preview" @click="shown = x" />
                <Button v-if="canPick() && several()" variant="icon" :compact-below="640" :label="t('common.download')" label-key="IconDownload" data-cp="download-one" @click="one(x)" />
              </template>
            </ListRow>
          </div>
        </Card>

        <PreviewWindow v-if="shown" :item="shown" :many="withPreview.length > 1" @close="shown = null" @step="step" @download="(x) => (several() ? one(x) : all())" />
      </section>
    </div>
  </section>
</template>
