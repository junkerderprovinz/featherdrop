<script lang="ts">
export type Panel = 'files' | 'upload' | 'link' | 'note' | 'request' | null;
</script>

<script setup lang="ts">
// The castle and what opens under it. On the bare start page it carries the claim and the three ways in; choosing
// one slides the castle up, at its size, and once it stands there the files, the note or the request opens beneath it
// in place of the rest. The upload and its link open in the same place, while the castle turns into the animation
// of the upload and back.
import { Button, Card, ListRow } from '@glimstone/vue';
import { nextTick, ref, watch } from 'vue';
import AppMark from '@/src/components/AppMark.vue';
import { fileCount, relative, size } from '@/src/format';
import { fileGlyph, G } from '@/src/glyphs';
import DropTarget from '@/src/gs-gaps/DropTarget.vue';
import { t } from '@/src/i18n';
import { dragging, pickFiles } from '@/src/intake';
import { follow } from '@/src/router';
import Done from '@/src/screens/Done.vue';
import Note from '@/src/screens/Note.vue';
import Options from '@/src/screens/Options.vue';
import Request from '@/src/screens/Request.vue';
import Uploading from '@/src/screens/Uploading.vue';
import { toast } from '@/src/toast';
import { contentTime } from '@/src/ui';
import { discardPending, openOptions, pending, resetSend, send, total } from '@/src/upload';

const props = defineProps<{ panel: Panel }>();

// The castle keeps its place in the flow and glides from where it stood to where the new layout puts it. What opens
// under it waits until it got there, and so does the file picker, which still opens within the click that asked
// for it since the glide takes well under a second.
const mark = ref<HTMLElement>();
const landed = ref(true);
let from: number | null = null;
let glide: Animation | undefined;
let then: (() => void) | null = null;

function land() {
  landed.value = true;
  const next = then;
  then = null;
  if (next) void nextTick(next);
}

function choose() {
  send.resuming = null;
  send.error = '';
  if (props.panel === 'files') return pickFiles();
  then = pickFiles;
  openOptions();
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

const top = (el: HTMLElement) => el.getBoundingClientRect().top + scrollY;

watch(() => props.panel, () => {
  from = mark.value ? top(mark.value) : null;
}, { flush: 'pre' });

watch(() => props.panel, (panel) => {
  if (panel !== 'files') then = null;
  const el = mark.value;
  glide?.cancel();
  const time = contentTime();
  const shift = el && from !== null ? from - top(el) : 0;
  if (!el || !shift || !time) return land();
  landed.value = false;
  const run = el.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: time * 2, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  glide = run;
  run.finished.then(() => glide === run && land(), () => {});
}, { flush: 'post' });
</script>

<template>
  <section class="cp-hero" :class="{ 'cp-hero-open': panel }">
    <template v-if="!panel">
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
    </template>
    <div ref="mark" class="cp-mark">
      <DropTarget :label="t('home.dropTarget')" :armed="dragging" :disabled="panel !== null && panel !== 'files'" @click="choose">
        <AppMark :size="280" :mode="panel === 'upload' ? 'upload' : 'idle'" :progress="send.progress" />
      </DropTarget>
    </div>
    <template v-if="!panel">
      <h1 class="cp-claim">{{ dragging ? t('home.dropping') : t('home.claim') }}</h1>
      <p class="cp-lead">{{ t('home.drop') }}</p>
      <div class="cp-start">
        <Button size="key" tone="accent" :label="t('home.choose')" label-key="IconUpload" data-cp="choose" @click="choose" />
        <Button size="key" tone="accent" :label="t('home.note')" label-key="IconPencil" href="/note" data-cp="to-note" @click="follow($event, '/note')" />
        <Button size="key" tone="accent" :label="t('home.request')" label-key="IconDownload" href="/request" data-cp="to-request" @click="follow($event, '/request')" />
      </div>
      <p class="cp-trust"><G n="IconShieldOn" />{{ t('home.trust') }}</p>
    </template>
    <div v-else-if="landed" :key="panel" class="cp-panel glim-content-fade" :data-cp="`panel-${panel}`">
      <Options v-if="panel === 'files'" />
      <Uploading v-else-if="panel === 'upload'" />
      <Done v-else-if="panel === 'link' && send.sent" :sent="send.sent" @more="resetSend" />
      <Note v-else-if="panel === 'note'" />
      <Request v-else />
    </div>
  </section>
</template>
