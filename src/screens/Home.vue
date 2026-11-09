<script setup lang="ts">
import { Button, Card, ListRow } from '@glimstone/vue';
import AppMark from '@/src/components/AppMark.vue';
import { fileCount, relative, size } from '@/src/format';
import { fileGlyph, G } from '@/src/glyphs';
import DropTarget from '@/src/gs-gaps/DropTarget.vue';
import { t } from '@/src/i18n';
import { dragging, pickFiles } from '@/src/intake';
import { follow } from '@/src/router';
import { toast } from '@/src/toast';
import { discardPending, pending, send, total } from '@/src/upload';

function choose() {
  send.resuming = null;
  send.error = '';
  pickFiles();
}

function pickAgain(id: string) {
  send.resuming = id;
  send.error = '';
  pickFiles();
}

async function discard(id: string) {
  await discardPending(id);
  toast(t('resume.discarded'));
}
</script>

<template>
  <section class="cp-hero">
    <Card v-for="p in pending.list" :key="p.id" class="cp-resume" :title="t('resume.title')" data-cp="resume">
      <p class="cp-text">{{ t('resume.text') }}</p>
      <div class="cp-rows" role="list">
        <ListRow v-for="f in p.files" :key="f.name" :name="f.name" role="listitem">
          <template #tile><G :n="fileGlyph(f.name)" /></template>
          <template #badges><span class="cp-size glim-num">{{ size(f.size) }}</span></template>
        </ListRow>
      </div>
      <div class="cp-card-foot">
        <span class="cp-sub glim-num">{{ fileCount(p.files.length) }}, {{ size(total(p.files)) }} · {{ t('resume.since', { when: relative(p.touchedAt) }) }}</span>
        <span class="cp-buttons">
          <Button :label="t('resume.discard')" label-key="IconTrash" data-cp="resume-discard" @click="discard(p.id)" />
          <Button tone="accent" :label="t('resume.pick')" label-key="IconUpload" data-cp="resume-pick" @click="pickAgain(p.id)" />
        </span>
      </div>
    </Card>
    <p v-if="send.error" class="cp-error" role="alert">{{ send.error }}</p>
    <DropTarget :label="t('home.dropTarget')" :armed="dragging" @click="choose">
      <AppMark :size="280" />
    </DropTarget>
    <h1 class="cp-claim">{{ dragging ? t('home.dropping') : t('home.claim') }}</h1>
    <p class="cp-lead">{{ t('home.drop') }}</p>
    <div class="cp-start">
      <Button size="key" tone="accent" :label="t('home.choose')" label-key="IconUpload" data-cp="choose" @click="choose" />
      <Button size="key" tone="accent" :label="t('home.note')" label-key="IconPencil" href="/note" data-cp="to-note" @click="follow($event, '/note')" />
      <Button size="key" tone="accent" :label="t('home.request')" label-key="IconDownload" href="/request" data-cp="to-request" @click="follow($event, '/request')" />
    </div>
    <p class="cp-trust"><G n="IconShieldOn" />{{ t('home.trust') }}</p>
  </section>
</template>
