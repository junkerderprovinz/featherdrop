<script setup lang="ts">
// Writes an encrypted note, a format 4 share the server cannot tell from a
// small file, with the same expiry, limit and password as files.
import { Button, Card, FieldRow, NumberField, PasswordField, Selector, TextArea, Toggle } from '@glimstone/vue';
import { Select } from '@glimstone/vue/Select';
import { computed, reactive, ref } from 'vue';
import { MAX_NOTE_BYTES, uploadNote } from '@/lib/e2e/note';
import { t } from '@/src/i18n';
import Done from '@/src/screens/Done.vue';
import Gate from '@/src/screens/Gate.vue';
import { eyeWords } from '@/src/ui';
import {
  explainUpload,
  expiryChoices,
  maxDownloads,
  passwordTooShort,
  startExpiry,
  uploadDeps,
  uploadLocked,
  type Limit,
  type Sent,
} from '@/src/upload';

const note = reactive({ text: '', expiry: startExpiry(), limit: 'none' as Limit, count: 3, locked: false, password: '' });
const busy = ref(false);
const error = ref('');
const sent = ref<Sent | null>(null);

const expiries = computed(() => expiryChoices().map((e) => ({ value: e, label: t('expiry.' + e) })));
const limits = computed(() => (['none', 'once', 'count'] as const).map((id) => ({
  id,
  label: t({ none: 'options.noLimit', once: 'options.once', count: 'options.count' }[id]),
  attrs: { 'data-cp': `limit-${id}` },
})));
const short = computed(() => passwordTooShort(note.locked, note.password));
const tooLong = computed(() => new TextEncoder().encode(note.text).length > MAX_NOTE_BYTES);
const count = computed({ get: () => note.count, set: (v: number | null) => { note.count = v ?? 1; } });

async function share() {
  busy.value = true;
  error.value = '';
  const limit = maxDownloads(note.limit, note.count);
  try {
    const links = await uploadNote(
      note.text,
      { expiry: note.expiry, maxDownloads: limit, password: note.locked ? note.password : undefined },
      uploadDeps(),
    );
    sent.value = { url: links.shareUrl, manageUrl: links.manageUrl, files: [], note: true, expiry: note.expiry, maxDownloads: limit, locked: note.locked, at: Date.now() };
  } catch (e) {
    error.value = explainUpload(e);
  } finally {
    busy.value = false;
  }
}

function again() {
  Object.assign(note, { text: '', locked: false, password: '' });
  sent.value = null;
}
</script>

<template>
  <Gate v-if="uploadLocked()" />
  <Done v-else-if="sent" :sent="sent" @more="again" />
  <section v-else class="cp-column">
    <Card :title="t('note.title')" :hint="t('note.hint')">
      <TextArea v-model="note.text" :label="t('note.label')" width="fill" :placeholder="t('note.placeholder')" class="cp-note-input" data-cp="note" />
      <p v-if="tooLong" class="cp-error cp-gap-top" role="alert">{{ t('note.tooLong') }}</p>
    </Card>
    <Card :title="t('options.options')">
      <FieldRow :label="t('options.expiry')" :hint="t('options.expiryHint')">
        <Select v-model="note.expiry" :options="expiries" list-id="cp-note-expiry" />
      </FieldRow>
      <FieldRow :label="t('options.downloads')" :hint="t('options.downloadsHint')">
        <Selector v-model="note.limit" :items="limits" size="sm" activation="manual" inline button-height pairs-on-phone data-cp="limit" />
      </FieldRow>
      <FieldRow v-if="note.limit === 'count'" :label="t('options.maxDownloads')">
        <NumberField v-model="count" />
      </FieldRow>
      <FieldRow :label="t('options.password')" :hint="t('options.passwordHint')">
        <Toggle v-model="note.locked" data-cp="lock" />
      </FieldRow>
      <FieldRow v-if="note.locked" :label="t('options.passwordField')">
        <PasswordField v-model="note.password" width="medium" autocomplete="new-password" :text="eyeWords()" data-cp="share-password" />
      </FieldRow>
      <p v-if="short" class="cp-hint-line" role="status" data-cp="password-short">{{ t('options.passwordShort') }}</p>
    </Card>
    <p v-if="error" class="cp-error" role="alert">{{ error }}</p>
    <div class="cp-actions">
      <Button size="key" tone="accent" :busy="busy" :disabled="!note.text || tooLong || short" :label="t('note.share')" label-key="IconUpload" data-cp="share-note" @click="share" />
    </div>
  </section>
</template>
