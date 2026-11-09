<script setup lang="ts">
// A decrypted note. It goes into the page as a text node inside a <pre>, so
// markup in a note is shown, never parsed.
import { Button } from '@glimstone/vue';
import { copyText } from '@/lib/clipboard';
import { t } from '@/src/i18n';
import { toast } from '@/src/toast';

const props = defineProps<{ text: string }>();

async function copy() {
  if (await copyText(props.text)) toast(t('note.copied'));
  else toast(t('common.copyFailed'), 'fail');
}
</script>

<template>
  <div class="cp-note">
    <pre class="cp-note-text">{{ text }}</pre>
    <div class="cp-actions">
      <Button :label="t('note.copy')" label-key="IconCopy" data-cp="copy-note" @click="copy" />
    </div>
  </div>
</template>
