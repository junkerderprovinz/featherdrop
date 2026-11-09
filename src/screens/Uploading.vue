<script setup lang="ts">
import { Button, Card, ListRow, Pill, ProgressBar } from '@glimstone/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppMark from '@/src/components/AppMark.vue';
import { confirm } from '@/src/confirm';
import { config } from '@/src/config';
import { duration, size } from '@/src/format';
import { G, fileGlyph } from '@/src/glyphs';
import { num, t } from '@/src/i18n';
import { toast } from '@/src/toast';
import { cancelUpload, send, sizes, total } from '@/src/upload';

const p = computed(() => send.progress);
const phase = computed(() => t('upload.' + send.phase));

// The time left follows a clock, since progress alone stands still between tus requests.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 1000)));
onBeforeUnmount(() => clearInterval(timer));

const left = computed(() => {
  const spent = (now.value - send.startedAt) / 1000;
  return p.value > 0.05 && p.value < 1 ? t('upload.left', { time: duration(spent / p.value - spent) }) : '';
});
const counted = computed(() => t('upload.status', { done: size(total(sizes()) * p.value), total: size(total(sizes())) }));

async function cancel() {
  if (!(await confirm(t('upload.cancelQuestion'), { confirmLabel: t('upload.cancel'), confirmLabelKey: 'IconStop' }))) return;
  if (send.stage !== 'uploading') return;
  await cancelUpload();
  toast(t('upload.cancelled'), 'warn');
}
</script>

<template>
  <section class="cp-column">
    <div class="cp-stage">
      <AppMark :size="220" mode="upload" :progress="p" />
      <div class="cp-stage-text" aria-live="polite">
        <span class="cp-phase">{{ phase }}</span>
        <span class="cp-percent glim-num">{{ num(p, { style: 'percent' }) }}</span>
      </div>
      <ProgressBar v-if="config.branding.logoUrl" class="cp-stage-bar" :value="p" :label="phase" />
      <p class="cp-sub glim-num">{{ counted }}<template v-if="left"> · {{ left }}</template></p>
    </div>

    <Card :title="t('upload.files')">
      <div class="cp-rows" role="list">
        <ListRow v-for="x in send.items" :key="x.id" :name="x.file.name" role="listitem">
          <template #tile><G :n="fileGlyph(x.file.name)" /></template>
          <template #badges>
            <Pill v-if="x.done >= x.file.size && p > 0" tone="ok">{{ t('upload.fileDone') }}</Pill>
            <span v-else-if="x.done === 0" class="cp-size">{{ t('upload.waiting') }}</span>
            <ProgressBar v-else class="cp-row-bar" :value="x.done / x.file.size" :label="x.file.name" />
          </template>
        </ListRow>
      </div>
    </Card>

    <div class="cp-actions">
      <Button :label="t('upload.cancel')" label-key="IconStop" data-cp="cancel" @click="cancel" />
    </div>
  </section>
</template>
