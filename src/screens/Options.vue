<script setup lang="ts">
import { Button, Card, EmptyState, FieldRow, ListRow, NumberField, PasswordField, Selector, Toggle } from '@glimstone/vue';
import { Select } from '@glimstone/vue/Select';
import { computed } from 'vue';
import { fileCount, size } from '@/src/format';
import { G, fileGlyph, glyph } from '@/src/glyphs';
import { t } from '@/src/i18n';
import { pickFiles } from '@/src/intake';
import { expiryChoices, hasJpeg, passwordTooShort, removeFile, resetSend, send, sizes, startUpload, total } from '@/src/upload';
import { eyeWords } from '@/src/ui';

const expiries = computed(() => expiryChoices().map((e) => ({ value: e, label: t('expiry.' + e) })));
const limits = computed(() => (['none', 'once', 'count'] as const).map((id) => ({
  id,
  label: t({ none: 'options.noLimit', once: 'options.once', count: 'options.count' }[id]),
  attrs: { 'data-cp': `limit-${id}` },
})));
const summary = computed(() => t('options.total', { count: fileCount(send.items.length), size: size(total(sizes())) }));
const short = computed(() => passwordTooShort(send.locked, send.password));
const count = computed({ get: () => send.count, set: (v: number | null) => { send.count = v ?? 1; } });
</script>

<template>
  <section class="cp-column">
    <Card :title="t('options.files')" :hint="t('options.filesHint')">
      <EmptyState v-if="!send.items.length" nested :glyph="glyph('IconEmpty')" :title="t('options.emptyTitle')" :hint="t('options.emptyHint')" />
      <div v-else class="cp-rows" role="list">
        <ListRow v-for="x in send.items" :key="x.id" :name="x.file.name" role="listitem">
          <template #tile><G :n="fileGlyph(x.file.name)" /></template>
          <template #badges><span class="cp-size glim-num">{{ size(x.file.size) }}</span></template>
          <template #actions><Button variant="icon" :compact-below="640" :label="t('common.remove')" label-key="IconClose" @click="removeFile(x.id)" /></template>
        </ListRow>
      </div>
      <div class="cp-card-foot">
        <span class="cp-sub glim-num">{{ send.items.length ? summary : '' }}</span>
        <Button :label="t('options.add')" label-key="IconAdd" data-cp="add" @click="pickFiles" />
      </div>
    </Card>

    <Card :title="t('options.options')">
      <FieldRow :label="t('options.expiry')" :hint="t('options.expiryHint')">
        <Select v-model="send.expiry" :options="expiries" list-id="cp-expiry" data-cp="expiry" />
      </FieldRow>
      <FieldRow :label="t('options.downloads')" :hint="t('options.downloadsHint')">
        <Selector v-model="send.limit" :items="limits" size="sm" activation="manual" inline button-height pairs-on-phone data-cp="limit" />
      </FieldRow>
      <FieldRow v-if="send.limit === 'count'" :label="t('options.maxDownloads')">
        <NumberField v-model="count" data-cp="max-downloads" />
      </FieldRow>
      <FieldRow :label="t('options.password')" :hint="t('options.passwordHint')">
        <Toggle v-model="send.locked" data-cp="lock" />
      </FieldRow>
      <FieldRow v-if="send.locked" :label="t('options.passwordField')">
        <PasswordField v-model="send.password" width="medium" autocomplete="new-password" :text="eyeWords()" data-cp="share-password" />
      </FieldRow>
      <p v-if="short" class="cp-hint-line" role="status" data-cp="password-short">{{ t('options.passwordShort') }}</p>
      <FieldRow v-if="hasJpeg()" :label="t('options.metadata')" :hint="t('options.metadataHint')">
        <Toggle v-model="send.strip" />
      </FieldRow>
    </Card>

    <p v-if="send.error" class="cp-error" role="alert">{{ send.error }}</p>
    <div class="cp-actions">
      <Button size="key" tone="accent" :label="t('options.upload')" label-key="IconUpload" :disabled="!send.items.length || short" data-cp="upload" @click="startUpload" />
    </div>
  </section>
</template>
