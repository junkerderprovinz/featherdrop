<script setup lang="ts">
// The link of a finished share, its QR code, what was sent and the private
// management link, for files and notes alike.
import { Button, Card, CopyField, FieldRow, SubCard } from '@glimstone/vue';
import { computed, onMounted } from 'vue';
import { expiryToTimestamp } from '@/lib/expiry';
import { config } from '@/src/config';
import { confetti } from '@/src/confetti';
import { dateTime, fileCount, size } from '@/src/format';
import QrCode from '@/src/gs-gaps/QrCode.vue';
import { plural, t } from '@/src/i18n';
import { prefs } from '@/src/prefs';
import { go } from '@/src/router';
import { toast } from '@/src/toast';
import { copyWords } from '@/src/ui';
import { total, type Sent } from '@/src/upload';

const props = defineProps<{ sent: Sent }>();
const emit = defineEmits<{ more: [] }>();

onMounted(() => {
  if (prefs.celebrate) confetti();
});

const expires = computed(() => {
  const at = expiryToTimestamp(props.sent.expiry, props.sent.at);
  return at === null ? t('done.neverExpires') : dateTime(at);
});
const downloads = computed(() =>
  props.sent.maxDownloads === null ? t('done.unlimited') : plural(props.sent.maxDownloads, 'done.downloadsCount'),
);
const what = computed(() =>
  props.sent.note ? t('note.label') : `${fileCount(props.sent.files.length)}, ${size(total(props.sent.files))}`,
);
const qrName = computed(() => config.branding.appName.toLowerCase().replace(/\s+/g, '-') + '-qr.png');
const manage = () => go(new URL(props.sent.manageUrl).pathname + new URL(props.sent.manageUrl).hash);
</script>

<template>
  <section class="cp-column">
    <Card :title="t('done.title')" :hint="sent.note ? t('done.noteHint') : t('done.hint')">
      <CopyField :value="sent.url" :label="t('done.link')" width="fill" :text="copyWords()" data-cp="link" @copy="(ok: boolean) => ok && toast(t('done.linkCopied'))" />
      <div class="cp-done">
        <QrCode :value="sent.url" :label="t('done.qr')" :save-label="t('done.saveQr')" :file-name="qrName" @saved="toast(t('done.qrSaved'))" />
        <SubCard class="cp-summary" :title="t('done.summary')">
          <FieldRow :label="t('done.files')" :value="what" />
          <FieldRow :label="t('done.expires')" :value="expires" />
          <FieldRow :label="t('done.downloads')" :value="downloads" />
          <FieldRow :label="t('done.password')" :value="sent.locked ? t('done.passwordSet') : t('done.passwordNone')" />
        </SubCard>
      </div>
    </Card>

    <Card :title="t('done.manage')" :hint="t('done.manageHint')">
      <CopyField :value="sent.manageUrl" :label="t('done.manageField')" width="fill" :text="copyWords()" data-cp="manage-link" />
      <FieldRow class="cp-gap-top" :label="t('done.manageRow')">
        <Button :label="t('done.openManage')" label-key="IconExternalLink" data-cp="open-manage" @click="manage" />
      </FieldRow>
    </Card>

    <div class="cp-actions">
      <Button size="key" tone="accent" :label="t('done.more')" label-key="IconAdd" data-cp="more" @click="emit('more')" />
    </div>
  </section>
</template>
