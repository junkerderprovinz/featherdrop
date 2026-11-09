<script setup lang="ts">
import { Button, EmptyState } from '@glimstone/vue';
import { glyph } from '@/src/glyphs';
import { t } from '@/src/i18n';
import { follow } from '@/src/router';
</script>

<template>
  <section class="cp-narrow">
    <EmptyState :glyph="glyph('IconUnlink')" :title="t('gone.missingTitle')" :hint="t('gone.missingText')">
      <Button :label="t('gone.send')" label-key="IconUpload" href="/" @click="follow($event, '/')" />
    </EmptyState>
  </section>
</template>
